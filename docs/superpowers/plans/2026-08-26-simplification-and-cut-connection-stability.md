# Simplification and Cut Connection Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove verified maintenance debt, make API access consistent under the Portal base path, and prevent `Ctrl` + left-drag connection cuts from crashing the canvas.

**Architecture:** Keep existing public APIs and media/task behavior unchanged. Reuse the existing application path helper for all browser-to-Next API calls; preserve the canvas interaction controller boundary and make its connection-cut completion independent of mutable controller state. Defer larger media and provider splits until a second consumer proves their value.

**Tech Stack:** Next.js 16, React 19, TypeScript, Bun tests, Go, GORM, Docker.

**Spec:** Audit findings from this task and the existing canvas interaction behavior.

## Global Constraints

- Preserve the user’s existing uncommitted prompt-persistence changes.
- Do not change Portal authentication, database schemas, media retention, provider protocols, or UI behavior except removing already-disabled text model actions in a separate, explicitly reviewed batch.
- Keep `bun.lock` as the only frontend dependency lockfile used by CI and Docker.
- Add regression tests before production code changes.

---

### Task 1: Stabilize Ctrl + left-drag connection cutting

**Files:**

- Modify: `web/src/app/(user)/canvas/hooks/use-canvas-interactions.ts:410-423`
- Modify: `web/src/app/(user)/canvas/hooks/use-canvas-interactions.test.ts`

**Interfaces:**

- `finishCutConnection(): boolean` must remove every intersected connection and clear the cut state.
- State-setter callbacks may run after `clearCutConnectionState()` changes the controller’s mutable state.

- [x] **Step 1: Write the failing regression test**

  Add a controller test whose `setConnections` queues its updater, call `finishCutConnection()`, flush the queued updater after cut state is cleared, and assert the matching connection is removed without throwing.

- [x] **Step 2: Verify the test fails before the fix**

  Run: `bun test 'src/app/(user)/canvas/hooks/use-canvas-interactions.test.ts'`

  Expected: the queued updater accesses `cutConnectionState.connectionIds` after that state has become `null`.

- [x] **Step 3: Implement the minimal fix**

  Snapshot `cutConnectionState.connectionIds` in a local `Set` before scheduling `setConnections` and `setSelectedConnectionId`; both callbacks close over that immutable snapshot rather than the mutable controller variable.

- [x] **Step 4: Verify the focused regression test passes**

  Run: `bun test 'src/app/(user)/canvas/hooks/use-canvas-interactions.test.ts'`

### Task 2: Consolidate browser API request paths and errors

**Files:**

- Modify: `web/src/lib/app-path.ts`
- Modify: `web/src/services/api/request.ts`
- Modify: `web/src/services/api/image.ts`
- Modify: `web/src/services/api/video.ts`
- Modify: `web/src/services/api/request.test.ts`
- Create: `web/src/services/api/video.test.ts`

**Interfaces:**

- All API calls must resolve `/api/...` through `NEXT_PUBLIC_BASE_PATH`.
- `apiRequestError(error, fallback)` must return the existing safe Chinese error messages for Axios and non-Axios failures.

- [x] **Step 1: Write failing API path and error-normalization tests**

  Test `appApiPath('/api/v1/videos')` with a Portal base path and verify the video request module uses that helper; test a 4xx Axios-like response preserves `msg`.

- [x] **Step 2: Verify the tests fail before the fix**

  Run: `bun test 'src/services/api/request.test.ts' 'src/services/api/video.test.ts'`

  Expected: video requests use `/api/v1/...` without the configured base path.

- [x] **Step 3: Implement the minimal shared helpers**

  Export the existing request-path and Axios-error normalization helpers from the API boundary; replace duplicate image/video helper implementations. Keep multipart upload behavior and response parsing unchanged.

- [x] **Step 4: Verify focused API tests pass**

  Run: `bun test 'src/services/api/request.test.ts' 'src/services/api/video.test.ts'`

### Task 3: Remove confirmed stale dependency artifacts and dead wrapper code

**Files:**

- Delete: `web/package-lock.json`
- Delete: `web/pnpm-lock.yaml`
- Delete: `web/src/components/ui/unused-ui-modules.test.ts`
- Modify: `web/package.json`
- Modify: `service/media.go:53-55`
- Modify: `service/media_test.go`

**Interfaces:**

- CI and Docker continue to use `bun install --frozen-lockfile` with `web/bun.lock`.
- Object-key production code continues to use `privateImageObjectKey` and `publicImageObjectKey`.

- [x] **Step 1: Retarget the object-key test to the actual upload source function**

  Change the existing test to call `privateImageObjectKey` with `MediaSourceUpload`; it documents the real implementation rather than a wrapper used only by the test.

- [x] **Step 2: Confirm the wrapper has no production callers**

  Run: `go test ./service -run TestImageObjectKeys`

- [x] **Step 3: Delete stale artifacts and wrapper**

  Remove both non-Bun lockfiles, the manifest-string test, and `imageObjectKey`; set `packageManager` to `bun@1.3.13` in the package manifest.

- [x] **Step 4: Verify dependency and media behavior**

  Run: `bun install --frozen-lockfile && go test ./service -run TestImageObjectKeys`

### Task 4: Restore build-time type safety

**Files:**

- Modify: `web/next.config.ts:14-16`

- [x] **Step 1: Confirm the current project typecheck passes**

  Run: `bun run typecheck`

- [x] **Step 2: Remove `typescript.ignoreBuildErrors`**

  Let `next build` fail when TypeScript fails, matching the existing CI gate.

- [x] **Step 3: Verify production compilation**

  Run: `bun run build`

### Task 5: Deliberately defer high-risk extractions

**Files reviewed:**

- `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`
- `web/src/services/image-storage.ts`
- `web/src/app/(user)/canvas/components/asset-picker-modal.tsx`
- `web/src/app/(user)/canvas/components/public-image-drawer.tsx`
- `service/media.go`
- `ai/providers/maizi.go`

- [x] **Step 1: Do not create a generic material drawer hook**

  The private drawer owns optimistic local upload and IndexedDB promotion; the public drawer owns server pagination and admin-only React Query mutations. Existing shared visual primitives are the correct reuse boundary.

- [x] **Step 2: Defer media/provider file splitting**

  `image-storage.ts`, `media.go`, and `maizi.go` each currently encapsulate concurrency or protocol invariants. Revisit only when a second storage provider or Maizi V2 endpoint requires distinct reuse.

- [x] **Step 3: Propose `use-canvas-media` only after isolated behavior tests exist**

  Before extracting upload, drop and visible-media hydration from `canvas-client-page.tsx`, first add behavior-level tests for those flows. Do not perform this high-risk extraction in the present cleanup batch.

### Task 6: Full verification and review

- [x] Run `bun test` from `web`.
- [x] Run `bun run typecheck` and `bun run build` from `web`.
- [x] Run `go test ./...` from the repository root.
- [x] Run `docker build --platform linux/amd64 -t infinite-canvas:local-audit .`.
- [ ] Run `git diff --check` and inspect the final diff to confirm only planned files changed.
