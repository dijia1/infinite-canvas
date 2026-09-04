# Simplification and Direct OSS Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove confirmed dead code, make browser uploads go directly to OSS through short-lived upload intents, and apply the small, safe reuse improvements identified in review.

**Architecture:** Keep the application authoritative for identity, object-key allocation, media records, and cleanup. An upload intent records the user, expected immutable upload metadata and expiry; the browser receives a signed OSS PUT URL, uploads directly, then calls a completion endpoint that verifies the object and creates the media record exactly once. Local storage retains the existing server-upload fallback.

**Tech Stack:** Go/Gin/GORM, Aliyun OSS SDK v2, Next.js/React, Axios, Bun tests.

**Spec:** `docs/superpowers/plans/2026-09-04-simplification-and-direct-uploads.md`

## Global Constraints

- Preserve Portal authentication and owner-scoped private media authorization.
- Do not expose OSS access keys to browsers; issue only short-lived signed PUT URLs.
- Keep browser display as direct signed OSS GET URLs.
- Validate completion metadata server-side and delete expired/unconfirmed intent objects.
- Retain local media storage behaviour through the existing multipart fallback.
- Do not restructure canvas persistence, OCC, share delivery, image workers, or provider implementations solely for line count.
- Do not mix repository-wide formatting changes with functional changes.

---

### Task 1: Remove confirmed dead export and statistics code

**Files:**
- Delete: `web/src/app/(user)/canvas/utils/canvas-export.ts`
- Delete: `web/src/app/(user)/canvas/export-types.ts`
- Delete: `web/src/lib/zip.ts`
- Modify: `web/src/services/file-storage.ts`
- Modify: `web/package.json`, `web/bun.lock`
- Modify: `web/src/app/(user)/canvas/stores/use-canvas-store.ts`
- Modify: `repository/image_generation_task.go`, `repository/image_generation_task_test.go`
- Modify: `model/image_generation_task.go`

**Interfaces:**
- Remove only symbols whose production callers are absent: ZIP project export, export-only blob helpers, store `importProject`, obsolete cost-summary query/type, and `IsTerminal`.

- [x] **Step 1: Verify each candidate has no production caller**

Run `rg` for `exportCanvasProjects`, `getMediaBlob`, `setMediaBlob`, `deleteStoredMedia`, `importProject`, `ListSucceededImageGenerationTaskCostSummariesFinishedBetween`, and `IsTerminal`.

- [x] **Step 2: Delete the confirmed dead production code and its dedicated test**

Keep `file-saver`, canvas single-image download helpers, database provider drivers, and legacy migration tests because each has active callers or protects persisted data.

- [x] **Step 3: Run focused tests and type checks**

Run `go test ./repository ./service`, `bun test` for the canvas store and storage cache tests, and `bun run typecheck`.

### Task 2: Add durable OSS upload intents

**Files:**
- Create: `model/media_upload_intent.go`
- Create: `repository/media_upload_intent.go`
- Modify: `repository/db.go`, `service/image_store.go`, `service/media.go`, `handler/media.go`, `router/router.go`
- Test: `service/media_test.go`, `repository/media_upload_intent_test.go`, `router/router_test.go`

**Interfaces:**
- `CreateMediaUploadIntent(ctx, user, input) (MediaUploadIntentView, error)` returns `{ id, uploadURL, expiresAt }` only for OSS storage.
- `CompleteMediaUploadIntent(ctx, user, id) (MediaAccess, error)` verifies the stored object’s exact byte size and MIME type, creates one private media record once, and returns its normal signed read access.
- `AbortExpiredMediaUploadIntents(ctx, before)` deletes expired intent records and their unconfirmed object keys.

- [x] **Step 1: Write failing repository and service tests**

Cover owner isolation, intent expiry, one completion creating exactly one media record, duplicate completion returning the existing record, mismatched object metadata rejection, and cleanup deleting only unconfirmed expired objects.

- [x] **Step 2: Add the model and GORM migration**

Persist `id`, `owner_uid`, `object_key`, `filename`, `content_type`, `expected_bytes`, `intent`, `expires_at`, `completed_media_id`, and timestamps. Index expiry and owner; make object key unique.

- [x] **Step 3: Extend the image store with signed PUT and HEAD metadata operations**

Implement for OSS with the configured public endpoint and signed expiry. Keep local storage unsupported for direct intent creation so existing multipart upload remains its fallback.

- [x] **Step 4: Implement service and handler endpoints**

Add `POST /api/v1/media/upload-intents` and `POST /api/v1/media/upload-intents/:id/complete`. The authenticated Portal UID is authoritative. Reject unsupported types, invalid filename, non-positive or oversized byte counts, expired intents, and mismatched object metadata.

- [x] **Step 5: Add bounded intent cleanup to the existing daily cleanup path**

Delete only expired, incomplete intent objects; retain completed records for a short audit window before deleting the intent row.

- [x] **Step 6: Run focused Go tests**

Run `go test ./repository ./service ./handler ./router` and verify an OSS integration upload manually against the configured test bucket.

### Task 3: Switch private browser uploads to direct OSS PUT

**Files:**
- Modify: `web/src/services/api/image.ts`
- Test: `web/src/services/api/image.test.ts` (create)

**Interfaces:**
- `uploadUserImage(file, intent)` first requests an intent, performs `fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } })`, then completes the intent.
- If the API reports `mode: "proxy"`, retain the current multipart endpoint for local-storage development.

- [x] **Step 1: Write failing API-client tests**

Assert OSS mode uses one intent request, one direct PUT with only the file MIME header, and one completion request; assert PUT failure does not call completion; assert proxy mode continues multipart upload.

- [x] **Step 2: Implement the smallest client change**

Do not put Portal tokens or OSS secrets in the direct upload request. Surface a clear upload failure to existing callers.

- [x] **Step 3: Run the focused Bun test and typecheck**

Run `bun test src/services/api/image.test.ts` and `bun run typecheck`.

### Task 4: Extract shared material preview behaviour and navigation data

**Files:**
- Create: `web/src/app/(user)/canvas/components/use-material-media-preview.ts`
- Modify: `web/src/app/(user)/canvas/components/asset-picker-modal.tsx`, `web/src/app/(user)/canvas/components/public-image-drawer.tsx`
- Create: `web/src/components/layout/admin-navigation.ts`
- Modify: `web/src/components/layout/app-top-nav.tsx`, `web/src/components/layout/mobile-nav-drawer.tsx`
- Test: focused preview hook and navigation tests

**Interfaces:**
- `useMaterialMediaPreview({ mediaId, loadAccess })` owns thumbnail loading, error state and original-image opening only; each drawer retains its own upload, permissions and context menu behaviour.
- `adminNavigationItems` is the one shared declaration used by desktop and mobile navigation.

- [x] **Step 1: Write failing tests for the shared hook and navigation items**

Assert private and public access factories yield thumbnail then original URLs, and both navigation renderers consume the statistics item.

- [x] **Step 2: Extract the hook and shared data with no behaviour changes**

Do not create a generic Drawer component or pass cross-domain upload props through it.

- [x] **Step 3: Run focused Bun tests and typecheck**

Run the material-drawer tests, preview hook test, navigation test, and `bun run typecheck`.

### Task 5: Apply small backend cohesion and deployment test improvements

**Files:**
- Create: `service/video_tasks.go`
- Modify: `service/settings.go`, `handler/media.go`, `service/public_images.go`, `service/private_images.go`
- Modify: `deployment_config_test.go`
- Test: `service/video_model_selection_test.go`, handler media tests, deployment configuration test

**Interfaces:**
- Video generation/query/content helpers live in `video_tasks.go`; settings retains settings persistence and provider configuration.
- Shared media DTOs and `normalizeMediaTitle` remain package-local and preserve JSON shapes.

- [x] **Step 1: Write or preserve focused tests before moving each behaviour**

Add deployment assertions for `json-file`, `20m`, and `5`; add upload-body-limit tests before retaining multipart fallback.

- [x] **Step 2: Move cohesive video task functions without changing exported signatures**

Relocate only the video task functions and their direct helpers; do not alter provider selection semantics.

- [x] **Step 3: Deduplicate media request DTOs and title normalizer**

Use named package-local structs for identical private/public update and folder payloads. Rename `normalizePublicTitle` to `normalizeMediaTitle` and retain its validation.

- [ ] **Step 4: Run focused and full verification**

Run `go test ./...`, `bun test`, `bun run typecheck`, `bun run build`, `git diff --check`, and confirm Docker Compose logging limits plus database auto-migration.
