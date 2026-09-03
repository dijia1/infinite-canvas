# Audited Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove confirmed dead paths, close the three validated backend safety gaps, and make the two material drawers share only their stable presentation pieces without changing product behavior.

**Architecture:** Preserve the current client/server boundaries and asynchronous task state machine. Treat text nodes as manual notes and prompt sources, not model-generation targets. Keep private/public drawer data, authorization and mutations separate; only extract presentation components and the shared grid-class mapping. Leave image-cache, canvas synchronization and worker claim logic untouched.

**Tech Stack:** Next.js 16, React 19, TypeScript, Bun/node:test, Go 1.25, Gin, GORM.

**Spec:** `docs/superpowers/plans/2026-09-02-local-runtime-audit-remediation.md`

## Global Constraints

- Work directly on the current `main` checkout per the user's established preference.
- Preserve Portal authorization, media identities, browser persistence and OSS behavior.
- Do not add dependencies or new global stores.
- Use behavior tests; remove source-text and CSS-shape assertions rather than preserving them.
- Do not refactor `image-storage.ts`, canvas project bootstrap, canvas synchronization, or image task claim/lease code in this change.

---

### Task 1: Fix request parsing limits and the Go test baseline

**Files:**
- Modify: `handler/settings.go:30-39`
- Modify: `handler/ai.go:47-72`, `handler/ai.go:197-220`
- Modify: `handler/ai_test.go`
- Modify: `handler/settings_test.go`
- Create: `repository/test_database_test.go`
- Modify: `repository/canvas_project_test.go:15-48`
- Modify: `repository/image_generation_task_test.go:15-29`

**Interfaces:**
- Produces `readMultipartImageReferences(files []*multipart.FileHeader, maxTotalBytes int64) ([]ai.ImageReference, error)` used by image-edit and video request parsing.
- Produces `useRepositoryTestDB(t *testing.T, cfg config.Config)` to isolate repository globals without copying `sync.Once`.

- [x] **Step 1: Write failing handler tests**

```go
func TestAdminSaveSettingsRejectsMalformedJSON(t *testing.T) {
    request := httptest.NewRequest(http.MethodPost, "/api/admin/settings", strings.NewReader("{"))
    recorder := httptest.NewRecorder()
    AdminSaveSettings(recorder, request)
    if response.Code != 1 || response.Msg != "系统设置请求无效" { t.Fatal("expected an invalid settings request response") }
}

func TestReadMultipartImageReferencesRejectsReferencesOverTheSharedLimit(t *testing.T) {
    request := multipartRequestWithFiles(t, "input_reference[]", [][]byte{[]byte("ab"), []byte("cd")})
    if _, err := readMultipartImageReferences(request.MultipartForm.File["input_reference[]"], 3); err == nil { t.Fatal("expected oversized reference error") }
}
```

- [x] **Step 2: Run the focused Go tests and verify the new tests fail**

Run: `go test ./handler -run 'Test(AdminSaveSettingsRejectsMalformedJSON|VideoRequestFromFormRejectsReferencesOverTheSharedLimit)' -count=1`

Expected: the parser helper does not exist before the fix, while malformed JSON is not reported as an invalid settings request.

- [x] **Step 3: Add bounded parsing and decode validation**

```go
const maxMultipartImageBytes int64 = 50 << 20

func readMultipartImageReferences(files []*multipart.FileHeader, maxTotalBytes int64) ([]ai.ImageReference, error) {
    // Read each file through io.LimitReader(maxMultipartImageBytes+1), reject an
    // oversized individual file and reject when the cumulative byte count exceeds maxTotalBytes.
}
```

Make `AdminSaveSettings` return `Fail(w, "系统设置请求无效")` when JSON decoding fails. Reuse the helper for image edits and videos while retaining the existing field names and 50 MiB aggregate contract.

- [x] **Step 4: Replace copied `sync.Once` test setup**

```go
func useRepositoryTestDB(t *testing.T, cfg config.Config) {
    t.Helper()
    previousConfig := config.Cfg
    config.Cfg, db, dbErr, dbOnce = cfg, nil, nil, sync.Once{}
    t.Cleanup(func() { config.Cfg, db, dbErr, dbOnce = previousConfig, nil, nil, sync.Once{} })
}
```

Do not restore a copied `sync.Once`; restore the test configuration and reset the database globals so the next test obtains a clean connection.

- [x] **Step 5: Verify Go behavior and vet**

Run: `go test ./handler ./repository -count=1 && go vet ./...`

Expected: parsing tests pass and `go vet` has no `sync.Once` copy diagnostics.

### Task 2: Remove the obsolete text-generation path and invisible non-image assets

**Files:**
- Modify: `web/src/services/api/image.ts`
- Modify: `web/src/app/(user)/canvas/types.ts`
- Modify: `web/src/app/(user)/canvas/hooks/use-canvas-generation.ts`
- Modify: `web/src/app/(user)/canvas/components/canvas-node-generation.ts`
- Modify: `web/src/app/(user)/canvas/components/canvas-node-prompt-panel.tsx`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`
- Modify: `web/src/app/(user)/canvas/components/canvas-node-hover-toolbar.tsx`
- Modify: `web/src/stores/use-asset-store.ts`
- Modify: `web/src/app/(user)/canvas/hooks/use-canvas-generation.test.ts`
- Modify: `web/src/stores/asset-storage-hydration.test.ts`

**Interfaces:**
- `CanvasGenerationMode` becomes `"image" | "video"`.
- Text nodes remain editable canvas content and usable upstream prompt input.
- `Asset` remains able to hydrate legacy persisted text/video records, but new canvas actions only save images because the materials UI only exposes images.

- [x] **Step 1: Write failing controller/UI tests**

```ts
test("text nodes cannot enter an unavailable text-model generation path", () => {
  assert.equal(defaultMode(CanvasNodeType.Text), "image");
});

test("saving a non-image node does not create an invisible private asset", () => {
  assert.equal(canSaveNodeAsAsset(textNode), false);
  assert.equal(canSaveNodeAsAsset(videoNode), false);
});
```

Extract only the pure `defaultMode` and `canSaveNodeAsAsset` decisions if needed for direct behavior tests; do not test JSX source text.

- [x] **Step 2: Run focused Bun tests and verify red**

Run: `cd web && bun test src/app/'(user)'/canvas/hooks/use-canvas-generation.test.ts src/app/'(user)'/canvas/[id]/canvas-save-asset.test.ts`

Expected: the old mode still resolves to `text`, and non-image save behavior remains reachable.

- [x] **Step 3: Delete the stale model path**

Remove `ChatCompletionMessage`, `requestImageQuestion`, `buildNodeChatMessages`, text-mode generation/retry branches, and their dependency plumbing. Keep text nodes, text-node editing, input ordering and text-to-image config creation. Rename the connection-menu item from `文本生成` to `文本节点`. Hide the node prompt-generation panel for text nodes rather than presenting a button that fails.

- [x] **Step 4: Stop creating invisible text/video material records**

Limit `saveNodeAsset` and the hover-toolbar save action to image nodes. Retain legacy `Asset` hydration types so existing browser storage remains readable and safely ignored by the image-only drawer.

- [x] **Step 5: Verify focused frontend behavior**

Run: `cd web && bun test src/app/'(user)'/canvas/hooks/use-canvas-generation.test.ts src/stores/asset-storage-hydration.test.ts && bun run typecheck`

Expected: text remains a canvas note/upstream input; no unavailable text request type remains.

### Task 3: Delete confirmed unreferenced frontend code and brittle source-shape tests

**Files:**
- Delete: `web/src/hooks/use-copy-text.ts`
- Delete: `web/src/components/image-generation-pending.tsx`
- Delete: `web/src/components/layout/github-link.tsx`
- Delete: `web/src/app/(user)/canvas/components/canvas-size-picker.tsx`
- Modify: `web/src/lib/image-utils.ts`
- Modify: `web/src/app/globals.css`
- Modify: `web/package.json`
- Modify: `web/bun.lock`
- Modify: `web/src/app/(user)/canvas/components/material-drawers.test.ts`

**Interfaces:**
- No public interface changes; the deleted files have no importers.

- [x] **Step 1: Verify the deletion candidates are unreferenced**

Run: `rg -n 'useCopyText|ImageGenerationPending|GithubLink|CanvasSizePicker|formatDuration' web/src`

Expected: each symbol only appears in its defining file or in tests that will be removed/adjusted.

- [x] **Step 2: Delete only the dead files and exclusive code**

Remove `copy-to-clipboard` from the manifest and lockfile with `bun remove copy-to-clipboard`; remove `formatDuration` and only `.canvas-control-select` / `.canvas-control-number` rules exclusive to `CanvasSizePicker`.

- [x] **Step 3: Replace source-shape assertions with behavior coverage**

Delete CSS/JSX/implementation-regex cases from `material-drawers.test.ts`. Retain pure folder-tree, cache and drag payload tests; do not replace visual-class assertions with new source scans.

- [x] **Step 4: Verify the dead-code removal**

Run: `cd web && bun test && bun run typecheck && bun run build`

Expected: no deleted symbol or dependency remains; behavior tests pass.

### Task 4: Share stable material-drawer presentation pieces

**Files:**
- Modify: `web/src/app/(user)/canvas/components/material-folder-ui.tsx`
- Create: `web/src/app/(user)/canvas/components/material-image-preview.tsx`
- Modify: `web/src/app/(user)/canvas/components/asset-picker-modal.tsx`
- Modify: `web/src/app/(user)/canvas/components/public-image-drawer.tsx`
- Modify: `web/src/app/(user)/canvas/components/material-drawers.test.ts`

**Interfaces:**
- `materialThumbnailGridClass(stage: number): string` returns one of the four literal Tailwind grid classes.
- `MaterialImagePreviewModal` accepts `{ preview?: { title: string; url: string }; onClose: () => void }` and owns only modal rendering.
- `MaterialBrokenImagePlaceholder` owns only the common broken-image presentation.

- [x] **Step 1: Write failing pure presentation tests**

```ts
test("maps all thumbnail stages to the supported grid classes", () => {
  assert.deepEqual([0, 1, 2, 3].map(materialThumbnailGridClass), ["grid-cols-6", "grid-cols-4", "grid-cols-3", "grid-cols-2"]);
});
```

- [x] **Step 2: Run the focused test and verify red**

Run: `cd web && bun test src/app/'(user)'/canvas/components/material-drawers.test.ts`

Expected: `materialThumbnailGridClass` is not exported yet.

- [x] **Step 3: Extract only display components**

Move the duplicated `Modal` and broken-state JSX to `material-image-preview.tsx`; move the literal grid mapping to `material-folder-ui.tsx`. Keep all loading, fetch, mutation, clipboard and authorization code in the private/public drawers.

- [x] **Step 4: Verify drawer regressions**

Run: `cd web && bun test src/app/'(user)'/canvas/components/material-drawers.test.ts src/app/'(user)'/canvas/components/material-drop.test.ts && bun run typecheck`

Expected: shared display behavior passes without reintroducing source-text assertions.

### Task 5: Remove confirmed Go dead symbols and make the media storage boundary explicit

**Files:**
- Delete: `middleware/admin.go`
- Modify: `repository/image_generation_task.go`
- Modify: `service/settings.go`
- Modify: `service/media.go`
- Create: `service/image_store.go`
- Modify: affected Go tests only if imports or package-local names require adjustment

**Interfaces:**
- `imageStore`, `localImageStore`, `ossImageStore`, and `newImageStore` remain package-private in `service`; only their file changes.

- [x] **Step 1: Verify the dead Go symbols have no callers**

Run: `rg -n 'AdminAuth|ListImageGenerationTasksForRecovery|resolveProvider\(' --glob '*.go'`

Expected: definitions only.

- [x] **Step 2: Delete dead functions and move storage drivers unchanged**

Delete the three unused symbols. Move the object-store interface and local/OSS implementations verbatim to `image_store.go`; keep media authorization, key construction, image validation and database operations in `media.go`.

- [x] **Step 3: Run focused Go tests**

Run: `go test ./service ./repository ./router -count=1 && go vet ./...`

Expected: package behavior is unchanged and vet is clean.

### Task 6: Final review and verification

**Files:**
- Modify: this plan, marking completed tasks after verification.

- [x] **Step 1: Inspect the final diff**

Run: `git diff --check && git diff --stat && git status --short`

Expected: only files named by this plan change; no generated artifacts or unrelated local changes appear.

- [x] **Step 2: Run complete relevant checks**

Run: `go test ./... -count=1 && go vet ./... && cd web && bun test && bun run typecheck && bun run build`

Expected: all checks pass.

- [x] **Step 3: Review the completion boundary**

Confirm that no change was made to image-cache internals, canvas bootstrap/sync, asynchronous image task CAS/lease logic, private/public folder permissions, or legacy migration behavior.

## Deliberately Deferred

- Do not introduce a composite image-provider interface solely to avoid repeated provider construction; it would add a new abstraction before a third active asynchronous provider proves the common contract.
- Do not split `canvas-client-page.tsx`, `canvas-node.tsx`, `use-canvas-generation.ts`, `image-storage.ts`, `image_task_worker.go`, or `canvas_projects.go` by line count. Their current state boundaries are coupled and already covered by high-value tests.
- Do not generalize private and public folders into one service/repository; their ownership and authorization contracts differ.
