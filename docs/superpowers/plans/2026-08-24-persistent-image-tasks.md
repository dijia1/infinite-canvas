# Persistent Image Task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MaiziAI image generation and editing durable asynchronous tasks that survive browser refreshes, network disconnects, and application restarts.

**Architecture:** The API persists an image task and returns immediately. A bounded in-process worker resolves the provider snapshot, creates or polls the provider task, persists output media, and records a terminal status. The canvas stores a browser-generated correlation ID before submission and resumes polling persisted tasks after reload.

**Tech Stack:** Go, GORM, SQLite/PostgreSQL/MySQL, Gin, OSS/local media storage, Next.js, React, Axios, Bun tests.

**Spec:** `docs/superpowers/specs/2026-08-24-persistent-image-tasks-design.md`

## Global Constraints

- Only `maizi-image` image generation and image editing move to persistent tasks in this change; video remains unchanged.
- No Redis or external queue dependency.
- `AI_TASK_WORKER_CONCURRENCY` is a positive integer environment variable and defaults to `4`.
- Existing task execution uses its persisted provider ID, type, and private config snapshot; later provider changes do not affect it.
- Worker HTTP/OSS activity must not hold a database transaction or connection.
- Worker polls MaiziAI every two seconds and uses a three-minute task timeout.
- Task records and their result mapping are retained for 30 days; temporary edit inputs are deleted in every terminal path.
- Preserve the existing Portal identity and ownership rules; no private configuration or provider credentials may appear in API responses or logs.
- Do not commit or reset the already dirty worktree while implementing this plan.

---

### Task 1: Define provider-level asynchronous image tasks

**Files:**

- Modify: `ai/registry.go`
- Modify: `ai/providers/maizi.go`
- Modify: `ai/providers/maizi_test.go`

**Interfaces:**

```go
type ImageTaskRequest struct {
    Request    ImageRequest
    References []ImageReference
}

type ImageTask struct {
    ID         string
    Status     string
    Progress   int
    ResultURLs []string
    Error      string
}

type ImageTaskProvider interface {
    CreateImageTask(context.Context, ImageTaskRequest) (ImageTask, error)
    GetImageTask(context.Context, string) (ImageTask, error)
}
```

- [ ] **Step 1: Write failing Maizi provider tests.**

Add tests proving `CreateImageTask` sends the configured model, image request fields and optional data URL references, returns the upstream `task_id` without calling `GET /tasks/:id`, and that `GetImageTask` maps `completed`, progress, URLs and upstream failure messages.

- [ ] **Step 2: Run the provider tests and verify failure.**

Run: `go test ./ai/providers -run 'TestMaizi.*(Create|Get).*Task'`

Expected: compile failure because the async provider interface and methods do not exist.

- [ ] **Step 3: Add the generic asynchronous task types and refactor MaiziAI.**

Replace the provider-local `generate`/`waitTask` loop with `CreateImageTask` and `GetImageTask`. `CreateImageTask` performs exactly one `POST /v1/images/generations`; `GetImageTask` performs exactly one `GET /v1/tasks/{id}`. Preserve existing request validation, resolution normalization and safe upstream errors.

- [ ] **Step 4: Run the provider test package.**

Run: `go test ./ai/providers`

Expected: all existing and new Maizi provider tests pass.

### Task 2: Persist task state, inputs and result mappings

**Files:**

- Create: `model/image_generation_task.go`
- Create: `repository/image_generation_task.go`
- Modify: `repository/db.go`
- Create: `repository/image_generation_task_test.go`

**Interfaces:**

```go
type ImageGenerationTaskStatus string

const (
    ImageTaskQueued     ImageGenerationTaskStatus = "queued"
    ImageTaskSubmitting ImageGenerationTaskStatus = "submitting"
    ImageTaskRunning    ImageGenerationTaskStatus = "running"
    ImageTaskSucceeded  ImageGenerationTaskStatus = "succeeded"
    ImageTaskFailed     ImageGenerationTaskStatus = "failed"
)

type ImageGenerationTask struct {
    ID, OwnerUID, ClientRequestID string
    Mode, ProviderID, ProviderType string
    ProviderConfig, ReferencesJSON, ResultMediaIDsJSON string
    Prompt, Quality, Size, Resolution, ProviderTaskID string
    Count, Progress int
    Status ImageGenerationTaskStatus
    ErrorMessage, CreatedAt, UpdatedAt, FinishedAt string
}
```

- [ ] **Step 1: Write repository tests.**

Cover owner-scoped idempotent creation by `ClientRequestID`, safe task claim from `queued`, task update with a provider task ID, loading by task ID/client request ID, stale non-terminal listing, terminal cleanup candidates and rejection of cross-owner reads.

- [ ] **Step 2: Run repository tests and verify failure.**

Run: `go test ./repository -run ImageGenerationTask`

Expected: compile failure because the model and repository are absent.

- [ ] **Step 3: Add the model, migration and atomic repository operations.**

Use a unique `(owner_uid, client_request_id)` index. Implement a conditional update claim so at most one worker transitions a queued/stale task into `submitting`; store JSON as strings after validation rather than adding an ORM-specific JSON dependency.

- [ ] **Step 4: Run repository tests.**

Run: `go test ./repository -run ImageGenerationTask`

Expected: repository tests pass against the existing test database setup.

### Task 3: Store temporary edit references without exposing them as media

**Files:**

- Modify: `service/media.go`
- Create: `service/image_task_inputs.go`
- Create: `service/image_task_inputs_test.go`

**Interfaces:**

```go
type ImageTaskInput struct {
    ObjectKey   string `json:"objectKey"`
    Name        string `json:"name"`
    ContentType string `json:"contentType"`
}

func SaveImageTaskInputs(ctx context.Context, taskID string, references []ai.ImageReference) ([]ImageTaskInput, error)
func ReadImageTaskInputs(ctx context.Context, inputs []ImageTaskInput) ([]ai.ImageReference, error)
func DeleteImageTaskInputs(ctx context.Context, inputs []ImageTaskInput) error
```

- [ ] **Step 1: Write storage tests.**

Cover local and test-store input object naming under `tasks/<task-id>/inputs/`, MIME and size validation, read-back preserving name/content type/data, and idempotent deletion.

- [ ] **Step 2: Run input-storage tests and verify failure.**

Run: `go test ./service -run ImageTaskInput`

Expected: compile failure because task input APIs do not exist.

- [ ] **Step 3: Extend the private storage abstraction only as needed.**

Add internal put/read/delete operations used by task inputs. The OSS implementation must use the internal endpoint; neither temporary input URL nor object key is returned by image task APIs.

- [ ] **Step 4: Run input-storage tests.**

Run: `go test ./service -run ImageTaskInput`

Expected: tests pass without real OSS credentials.

### Task 4: Implement service creation, Worker execution and retention

**Files:**

- Create: `service/image_tasks.go`
- Create: `service/image_task_worker.go`
- Create: `service/image_tasks_test.go`
- Modify: `service/settings.go`
- Modify: `service/generated_images.go`
- Modify: `config/config.go`
- Modify: `.env.example`
- Modify: `main.go`

**Interfaces:**

```go
type CreateImageTaskRequest struct {
    ClientRequestID string
    Mode            string
    Request         ai.ImageRequest
    References      []ai.ImageReference
}

type ImageTaskView struct {
    ID, ClientRequestID, Status, Error string
    Progress int
    Images   []MediaAccess
}

func CreateImageTask(ctx context.Context, user PortalUser, request CreateImageTaskRequest) (ImageTaskView, error)
func GetImageTask(ctx context.Context, user PortalUser, id string) (ImageTaskView, error)
func GetImageTaskByClientRequest(ctx context.Context, user PortalUser, clientRequestID string) (ImageTaskView, error)
func StartImageTaskWorker(ctx context.Context) func()
```

- [ ] **Step 1: Write service tests.**

Cover immediate queued creation; instance/config snapshot use after the default provider changes; worker claim/create/poll/success path; failure path; result media persistence before status becomes successful; restart scan of an existing running task; invalid worker concurrency config; owner/admin authorization; and terminal task retention cleanup.

- [ ] **Step 2: Run service tests and verify failure.**

Run: `go test ./service -run 'ImageTask|ImageGenerationTask'`

Expected: failure because no task service or worker exists.

- [ ] **Step 3: Implement task creation and a bounded Worker.**

`CreateImageTask` validates the selected provider, creates a task with provider snapshot and temporary edit inputs, and signals the worker. `StartImageTaskWorker` parses `AI_TASK_WORKER_CONCURRENCY` with default `4`, uses that many goroutines, and sweeps non-terminal tasks at startup and periodically. Every external request happens outside database operations.

- [ ] **Step 4: Implement MaiziAI task processing.**

For `queued/submitting`, reconstruct the provider from the stored snapshot and call `CreateImageTask`; save `ProviderTaskID` before polling. For `running`, call `GetImageTask` every two seconds. On completion, download/persist every returned result through the existing generated-media path using `WithPortalUser`; then atomically save all media IDs and mark success. On failure or timeout, save a safe error and clean task inputs.

- [ ] **Step 5: Start worker and configure its concurrency.**

Add `AITaskWorkerConcurrency int \`env:"AI_TASK_WORKER_CONCURRENCY" envDefault:"4"\`` to configuration, document it in `.env.example`, call `StartImageTaskWorker` after configuration load, and stop it through the existing main lifecycle defer path.

- [ ] **Step 6: Run service tests.**

Run: `go test ./service -run 'ImageTask|ImageGenerationTask'`

Expected: all async image task tests pass.

### Task 5: Expose task APIs while preserving Portal ownership

**Files:**

- Modify: `handler/ai.go`
- Modify: `router/router.go`
- Modify: `router/router_test.go`

**Interfaces:**

```text
POST /api/v1/images/generations          -> 202 { id, clientRequestId, status, progress }
POST /api/v1/images/edits                -> 202 { id, clientRequestId, status, progress }
GET  /api/v1/image-tasks/:id             -> { id, clientRequestId, status, progress, error?, images? }
GET  /api/v1/image-tasks/by-client/:id   -> same response
```

- [ ] **Step 1: Write router/handler tests.**

Test that both image POST routes return immediately with `202`, require Portal identity, accept and validate `clientRequestId`, retain multipart references, reject cross-user lookup, allow administrators to inspect when necessary, and do not expose provider configuration or temporary input locations.

- [ ] **Step 2: Run router tests and verify failure.**

Run: `go test ./router -run 'ImageTask|ImagesGenerations|ImagesEdits'`

Expected: failure because the response and task routes are absent.

- [ ] **Step 3: Replace synchronous handlers with task creation.**

Parse the existing JSON/multipart fields, retrieve the Portal user from context, call `service.CreateImageTask`, set HTTP status `202`, and record accepted/terminal audit events in the service Worker rather than falsely recording success at submission.

- [ ] **Step 4: Add task status handlers and routes.**

Use the service read APIs and existing JSON response envelope. Do not add public unauthenticated task endpoints.

- [ ] **Step 5: Run router tests.**

Run: `go test ./router -run 'ImageTask|ImagesGenerations|ImagesEdits'`

Expected: route/authorization tests pass.

### Task 6: Persist browser correlation and resume canvas image tasks

**Files:**

- Modify: `web/src/services/api/image.ts`
- Create: `web/src/services/api/image-tasks.ts`
- Create: `web/src/services/api/image-tasks.test.ts`
- Modify: `web/src/app/(user)/canvas/types.ts`
- Modify: `web/src/app/(user)/canvas/hooks/use-canvas-generation.ts`
- Modify: `web/src/app/(user)/canvas/hooks/use-canvas-generation.test.ts`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`
- Create: `web/src/app/(user)/canvas/utils/canvas-image-task-recovery.ts`
- Create: `web/src/app/(user)/canvas/utils/canvas-image-task-recovery.test.ts`

**Interfaces:**

```ts
type ImageTaskStatus = "queued" | "submitting" | "running" | "succeeded" | "failed";
type ImageTaskResponse = {
    id: string;
    clientRequestId: string;
    status: ImageTaskStatus;
    progress: number;
    error?: string;
    images?: Array<{ mediaId: string; url: string; width: number; height: number; contentType: string }>;
};

type CanvasNodeMetadata = {
    generationTaskId?: string;
    clientRequestId?: string;
    // existing metadata remains unchanged
};
```

- [ ] **Step 1: Write API and recovery tests.**

Cover `202` task parsing, safe error parsing, client-ID lookup after a lost POST response, task polling that stops on terminal state, and turning a completed task into image metadata without creating a duplicate node.

- [ ] **Step 2: Run frontend tests and verify failure.**

Run: `bun test src/services/api/image-tasks.test.ts 'src/app/(user)/canvas/utils/canvas-image-task-recovery.test.ts'`

Expected: failure because task API/recovery modules are absent.

- [ ] **Step 3: Replace immediate image response assumptions.**

Create a stable `clientRequestId` before every single-image request, save it with loading node metadata, POST the task request, save the returned server task ID, then poll task status. On success use the returned media ID and existing image cache service to materialize the node; on failure preserve the node and write the server safe error.

- [ ] **Step 4: Add refresh recovery.**

When a canvas loads, scan image nodes still marked `loading` with either task ID or client request ID. Resume bounded browser polling for those nodes only. A node that already has final media is ignored; no new task is submitted during recovery.

- [ ] **Step 5: Run targeted frontend tests.**

Run: `bun test src/services/api/image-tasks.test.ts 'src/app/(user)/canvas/utils/canvas-image-task-recovery.test.ts' src/app/'(user)'/canvas/hooks/use-canvas-generation.test.ts`

Expected: task submission and refresh recovery tests pass.

### Task 7: Full verification and scoped diff review

**Files:**

- Modify only files required by Tasks 1–6.

- [ ] **Step 1: Run backend tests.**

Run: `go test ./...`

Expected: all Go tests pass without external MaiziAI, OSS, or Portal credentials.

- [ ] **Step 2: Run frontend tests and type check.**

Run: `cd web && bun test && bun run typecheck`

Expected: all Bun tests and TypeScript type checking pass.

- [ ] **Step 3: Run the production frontend build.**

Run: `cd web && bun run build`

Expected: optimized Next build completes successfully.

- [ ] **Step 4: Run Docker build if the existing Dockerfile includes the changed services.**

Run: `docker compose build infinite-canvas`

Expected: local image build succeeds without pulling a remote application image.

- [ ] **Step 5: Inspect the scoped diff.**

Run: `git diff --check` and `git diff -- <task files>`.

Expected: no whitespace errors and no unrelated user changes overwritten.
