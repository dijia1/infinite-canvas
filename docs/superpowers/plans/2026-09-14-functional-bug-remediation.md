# Functional Bug Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the seven confirmed functional defects in small, reviewable batches while preserving historical data, preventing duplicate generation charges, and retaining existing Canvas and Workflow behavior.

**Architecture:** Keep provider-specific status handling inside providers, task state transitions inside workers, and persistence/concurrency guarantees inside repositories. Add only the data required for optimistic or idempotent comparison. Every concurrency fix is verified with independently scheduled database connections and an observed blocking/interleaving point.

**Tech Stack:** Go, GORM, PostgreSQL, Gin, React/TypeScript, Bun.

**Spec:** The seven confirmed findings in the 2026-09-14 functional audit in the current Codex task.

## Global Constraints

- Verify the actual caller chain, state rules, and compatibility before changing each defect.
- Use the smallest change that repairs the invariant; do not refactor unrelated provider, media, workflow, or Canvas architecture.
- A resumed generation task must continue the existing upstream task and must never submit or charge a second generation implicitly.
- Database additions must accept historical rows and preserve existing unique constraints and records.
- Canvas validation must accept legitimate historical documents and must not make an existing board permanently unsaveable.
- Add a failing regression test before production code; concurrency defects require real overlapping database transactions.
- Commit each task separately and report each batch before starting the next one.
- Do not address the three deployment or policy risks from the audit in this plan.

---

## Batch 1: Generation identity, idempotency, and folder integrity

### Task 1: Persist an image provider task ID before terminal handling

**Files:**
- Modify: `service/image_task_worker.go`
- Test: `service/image_task_worker_test.go`
- Possibly modify only if atomic persistence needs it: `repository/image_generation_task.go`

**Interfaces:**
- Consumes: `ai.ImageTask`, `repository.SetImageGenerationTaskProviderTaskID`, existing claimed-task fencing.
- Produces: an image task whose non-empty upstream ID survives synchronous `completed`, `failed`, and `uncertain` create responses.

- [ ] Trace `CreateImageTask`, terminal classification, task completion/failure, operation-log update, and claim fencing. Record whether each path currently persists `ProviderTaskID`.
- [ ] Add table-driven worker tests for synchronous `completed`, `failed`, and `uncertain` responses carrying an upstream ID. Assert the task and operation record retain that ID, no polling occurs for terminal responses, and no second create call occurs.
- [ ] Run the new tests and confirm they fail because `provider_task_id` is empty.
- [ ] Move extraction and persistence of a non-empty upstream ID ahead of terminal dispatch. Keep create transport errors uncertain and never resubmit them automatically.
- [ ] If separate updates leave a crash window that violates existing fencing, add one repository transition that writes the provider ID and state under the current claim instead of introducing a general task-state abstraction.
- [ ] Run the focused worker tests and image provider/service regression tests.
- [ ] Commit as `fix: preserve image provider task identity`.

### Task 2: Enforce payload-consistent generation idempotency

**Files:**
- Modify: `model/image_generation_task.go`
- Modify: `model/video_generation_task.go`
- Modify: `repository/image_generation_task.go`
- Modify: `repository/video_generation_task.go`
- Modify: `service/image_tasks.go`
- Modify: `service/video_generation_tasks.go`
- Modify: `handler/ai.go`
- Modify: `web/src/services/api/image.ts`
- Modify: `web/src/app/(user)/canvas/hooks/use-canvas-generation.ts`
- Modify: the existing database migration/AutoMigrate registration only as required by project conventions
- Test: image/video service and repository task tests

**Interfaces:**
- Produces: nullable/backward-compatible `RequestHash` fields and one shared semantic error for “same idempotency key, different normalized request”.
- The hash input is canonical JSON built from persisted, stable request identity: selected provider, normalized model/options, ordered media IDs, generation mode, and other billed/output-affecting fields. It excludes signed URLs, temporary local paths, timestamps, claims, progress, and audit-only display fields.

- [ ] Trace both handlers through request normalization, provider selection, input resolution, temporary input creation, unique insertion, and duplicate lookup. Document which side effects happen before the unique constraint.
- [ ] Add migration coverage proving historical task rows receive an empty/null hash without failing startup or becoming unreadable.
- [ ] Add service tests showing an exact replay returns the existing task and a changed prompt/model/options/media order returns a conflict.
- [ ] Add a PostgreSQL concurrency test that releases two requests with the same key and different hashes together. Assert one insert and one conflict, one operation log, one queued task, and no second billable submission.
- [ ] Run the new tests and confirm the mismatch and concurrency assertions fail on the current implementation.
- [ ] Calculate the canonical hash only after semantic normalization. Store it on new image/video tasks and compare it inside the insert-conflict transaction.
- [ ] Map a mismatch to HTTP 409 using the existing application error style. For historical rows without a hash, preserve the old replay behavior; do not guess a hash from incomplete legacy data.
- [ ] Give image requests the same explicit non-retryable 4xx classification already used by video requests. The Canvas generation hook must not recover a 409 by client request ID and silently accept the older, different task.
- [ ] Ensure duplicate image attempts clean only newly-created temporary inputs and never delete inputs owned by the existing task.
- [ ] Run focused image/video service and repository tests, then generation worker regressions.
- [ ] Commit as `fix: validate generation idempotency payloads`.

### Task 3: Serialize private-folder deletion with child creation and media moves

**Files:**
- Modify: `repository/private_folder.go`
- Modify: the repository function that moves private media
- Modify: `service/private_images.go`
- Test: `repository/private_folder_test.go` or the nearest existing private-media repository test
- Test: relevant service private-image tests

**Interfaces:**
- Produces: repository operations that lock the target folder row before adding a child, moving media into it, or checking-and-deleting it.
- Lock order: owner-qualified target folder first, then child/media existence checks or writes. No folder relation means the root and requires no folder-row lock.

- [ ] Trace every write that can create a reference to `private_folders.id`, including child creation and media-folder changes. Confirm owner scoping and current error messages.
- [ ] Add a real PostgreSQL interleaving test where one transaction holds the parent lock while a concurrent delete waits; insert a child, commit, then verify deletion rechecks and refuses.
- [ ] Add the inverse interleaving where delete wins and a concurrent child creation or media move wakes after commit, observes the missing folder, and fails without an orphan row.
- [ ] Confirm both tests fail against the current split check/delete and unlocked writers.
- [ ] Replace the service-level check-then-delete sequence with one repository transaction using `SELECT ... FOR UPDATE`, content recheck, and delete.
- [ ] Make child creation and media movement lock and validate the destination folder in the same transaction as their write. Preserve owner checks and user-facing messages.
- [ ] Do not introduce a broad folder subsystem rewrite or change deletion semantics for non-empty folders.
- [ ] Run focused repository/service tests with the test PostgreSQL database, including race-sensitive repetitions.
- [ ] Commit as `fix: serialize private folder membership changes`.

## Batch 2: Task-state convergence and audit truth

### Task 4: Stop Workflow from resetting paused-video retry budgets

**Files:**
- Modify: `service/workflow_scheduler.go`
- Modify only if needed for an explicit same-task resume: `service/video_generation_tasks.go`
- Modify: Workflow run/output API client and UI files that expose the existing same-task resume endpoint
- Test: `service/workflow_scheduler_test.go`
- Test: `service/video_generation_tasks_test.go`
- Test: relevant Workflow run-state and output-action frontend tests

**Interfaces:**
- Consumes: existing `paused` and `uncertain` video task states and `ResumeVideoGenerationTask`.
- Produces: a stable attention-required Workflow state after the retry budget is exhausted; any explicit recovery continues the same `provider_task_id` and does not call provider create.

- [ ] Trace automatic scheduler polling, user retry actions, task resume, output retry, and run aggregation. Confirm which action is intended to leave `attention_required`.
- [ ] Add a test that drives five failures into `paused`, runs multiple scheduler passes, and proves attempts/deadline are not silently reset.
- [ ] Add a recovery test asserting an explicit resume/retry keeps the same task ID and upstream ID and records zero additional create calls.
- [ ] Remove unconditional scheduler resume. Expose an explicit Workflow action that calls the existing same-task resume endpoint; it must retain the local task, operation log, and upstream task IDs and must not route through ordinary output retry/new-task creation.
- [ ] Update the attention-required copy so it asks the user to resume the original task instead of claiming that recovery is already in progress.
- [ ] Run Workflow scheduler, video task, stop/retry, and run-state tests.
- [ ] Commit as `fix: preserve workflow video retry exhaustion`.

### Task 5: Project image uncertain states into operation audit

**Files:**
- Modify: `service/image_task_worker.go`
- Modify: `service/operation_log.go`
- Modify: `repository/operation_log.go`
- Modify only if the existing enum cannot represent the view: `model/operation_log.go`
- Modify: `web/src/services/api/operation-logs.ts`
- Modify: `web/src/app/(admin)/admin/operations/page.tsx`
- Test: image worker and operation-log repository/service tests
- Test: admin operations API/page tests

**Interfaces:**
- Produces: operation listings and status filters that report the current derived state for both image and video tasks.

- [ ] Trace every image terminal/uncertain transition and the admin operation-list status projection/filter.
- [ ] Add tests showing an uncertain image task is visible under the uncertain filter and is not displayed as submitted.
- [ ] Confirm the tests fail because only video tasks participate in derived-state filtering.
- [ ] Update image uncertain transitions and list/filter projection using the existing safe error channel. Preserve the operation row's coarse submitted/success/failure audit status when possible and expose the linked task's derived status separately, matching the video projection. Avoid storing raw provider responses, prompts beyond current audit policy, or credentials.
- [ ] Preserve historical operation rows that have no linked task.
- [ ] Run image worker, operation-log, and admin operations tests.
- [ ] Commit as `fix: synchronize image task audit states`.

## Batch 3: Configuration CAS and compatible Canvas invariants

### Task 6: Add optimistic concurrency to full AI-settings saves

**Files:**
- Modify: `model/setting.go`
- Modify: `repository/setting.go`
- Modify: `service/settings.go`
- Modify: `handler/settings.go`
- Modify: admin settings API client/types/page as required to send the revision
- Test: repository/service/router settings tests and admin settings tests

**Interfaces:**
- Produces: a backward-compatible settings revision returned by reads and required for updates once a record exists; stale saves return HTTP 409.

- [ ] Trace settings bootstrap, read, full-form edit, save, cache invalidation, and audit recording.
- [ ] Add migration tests for an existing `ai` setting without revision and define its initial revision deterministically.
- [ ] Add a real two-client test: both read revision N, A saves to N+1, B attempts N and receives 409 without overwriting A.
- [ ] Confirm the test fails on the current blind upsert.
- [ ] Add revision/CAS to the single settings row using one conditional update transaction. Preserve the existing normalized full-document format.
- [ ] Return the current revision in the conflict response without exposing provider secrets beyond the existing authorized settings response.
- [ ] Update the admin client to retain the loaded base revision and surface the existing conflict error pattern.
- [ ] Run settings backend and admin frontend tests.
- [ ] Commit as `fix: reject stale ai settings saves`.

### Task 7: Enforce Canvas graph invariants without trapping historical boards

**Files:**
- Modify: `service/canvas_projects.go`
- Modify: `service/canvas_share.go`
- Modify only if create/update need different compatibility input: Canvas service/repository call sites
- Test: `service/canvas_projects_test.go` and router Canvas tests
- Test: Canvas share service/router tests

**Interfaces:**
- Produces: strict validation for newly introduced invalid geometry/IDs while retaining a compatible update path for pre-existing documents.

- [ ] Enumerate all current and legacy Canvas node shapes, connection endpoint conventions, batch/output nodes, and minimum dimensions from frontend types and migration tests.
- [ ] Scan available local/test fixtures for zero dimensions, duplicate IDs, and dangling edges; do not infer production prevalence from fixtures.
- [ ] Add tests rejecting newly created zero/negative dimensions, duplicate node/connection IDs, and dangling endpoints.
- [ ] Add compatibility tests for every legitimate historical shape found during tracing, including old optional metadata and output-node forms.
- [ ] Confirm invalid-input tests fail against the current validator.
- [ ] Add uniqueness, endpoint, and positive-dimension validation using the broadest legitimate historical bounds. If an existing stored document contains a formerly accepted invalid fragment, compare against the stored baseline so an unrelated edit is not trapped; reject newly introduced or worsened violations.
- [ ] Use the same baseline-compatible validation when sharing a historical Canvas. Sharing may rewrite media metadata but must not make a legacy board unshareable or introduce/worsen graph violations.
- [ ] Preserve successful idempotent update replays after the project has advanced beyond the replayed request's base revision; baseline lookup must not turn an already-recorded replay into a conflict.
- [ ] Preserve revision, media validation, cleanup, and idempotency behavior.
- [ ] Run Canvas service/router tests and frontend document/bootstrap/autosave regressions.
- [ ] Commit as `fix: validate canvas graph invariants safely`.

## Batch and final verification

- [ ] After each batch, run focused Go tests with the isolated test database, `go vet` for affected packages, relevant Bun tests, TypeScript checks, and `git diff --check`.
- [ ] Report the commits, tests, observed concurrency interleavings, behavior changes, and remaining risks before continuing to the next batch.
- [ ] After all tasks, run `go test ./...`, race tests for affected repository/service packages, `bun test`, `bunx tsc --noEmit --incremental false`, the frontend production build, and `git diff --check`.
- [ ] Perform a whole-branch code review against the starting commit, resolve important findings, and report any explicitly deferred limitations.
