# Canvas Mask Resource Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep hand-drawn masks once per canvas, preserve retry correctness, and make oversized canvas saves explain their actual cause.

**Architecture:** Add a document-level `maskResources` map keyed by stable mask IDs. Nodes retain only `maskId` and optional `sourceNodeId`; legacy node-local masks are migrated while loading and before saving. The server remains the document authority and accepts documents up to 4 MiB, reporting a dedicated limit error rather than a generic validation error.

**Tech Stack:** Next.js/React, TypeScript, Zustand + IndexedDB persistence, Go HTTP service, PostgreSQL.

**Spec:** User-confirmed save-failure remediation in this task.

## Global Constraints

- Preserve current local-first, revisioned canvas sync behavior.
- Keep old `imageMask` and `referenceMasks` readable only as migration sources.
- Do not persist signed URLs, Blob URLs, or Base64 media content.
- Do not alter unrelated image-performance changes already present in the worktree.

---

### Task 1: Add normalized canvas-level mask resources

**Files:**
- Create: `web/src/app/(user)/canvas/image-mask/mask-resources.ts`
- Test: `web/src/app/(user)/canvas/image-mask/mask-resources.test.ts`
- Modify: `web/src/app/(user)/canvas/types.ts`

**Interfaces:**
- Produces `CanvasMaskResources`, `migrateCanvasMaskResources`, `resolveCanvasNodeMask`, and `replaceCanvasNodeMask`.
- `CanvasNodeMetadata.maskId` identifies the immutable mask snapshot a generated node must use for retry.

- [x] Write a failing migration test with one source image and several generated nodes carrying identical legacy `referenceMasks`; assert one resource remains and every generated node stores the same `maskId` without `referenceMasks`.
- [x] Run `bun test web/src/app/(user)/canvas/image-mask/mask-resources.test.ts`; verify it fails because the module does not exist.
- [x] Implement normalized resource migration, legacy fallback lookup, resource pruning, and new node metadata fields.
- [x] Run the focused test; verify the legacy input is converted without copying mask strokes per generated node.

### Task 2: Persist and restore the compact document shape

**Files:**
- Modify: `web/src/services/api/canvas-projects.ts`
- Modify: `web/src/services/canvas-project-document.ts`
- Modify: `web/src/services/canvas-project-document.test.ts`
- Modify: `web/src/app/(user)/canvas/stores/use-canvas-store.ts`
- Test: `web/src/app/(user)/canvas/stores/use-canvas-store.test.ts`

**Interfaces:**
- `CanvasProjectDocument.maskResources` carries project-level resources.
- `sanitizeCanvasProjectDocument(document)` produces a compact, backward-compatible document before every local or server persistence operation.

- [x] Write a failing document-sanitizer test with legacy source `imageMask` and generated `referenceMasks`; assert persisted nodes contain only IDs and the document contains one resource.
- [x] Run `bun test web/src/services/canvas-project-document.test.ts`; verify it fails on missing `maskResources` migration.
- [x] Add `maskResources` to API/store project shapes, create/import/default/restore paths, persistence patches, and local storage migration.
- [x] Run document and store tests; verify hydrated old documents are compacted and future saves retain the resource map.

### Task 3: Use stable mask snapshots for rendering, generation, and retry

**Files:**
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`
- Modify: `web/src/app/(user)/canvas/components/canvas-node.tsx`
- Modify: `web/src/app/(user)/canvas/components/canvas-node-generation.ts`
- Modify: `web/src/app/(user)/canvas/utils/canvas-generation-utils.ts`
- Modify: `web/src/app/(user)/canvas/hooks/use-canvas-generation.ts`
- Test: `web/src/app/(user)/canvas/components/canvas-node-generation.test.ts`
- Test: `web/src/app/(user)/canvas/utils/canvas-generation-utils.test.ts`
- Test: `web/src/app/(user)/canvas/hooks/use-canvas-generation.test.ts`

**Interfaces:**
- Mask editing creates a new `maskId`; it never mutates a mask already referenced by generated output.
- `ReferenceImage.maskId` carries generation provenance, while `ReferenceImage.mask` is supplied only to the current provider request.

- [x] Write failing tests proving a generated node stores `maskId` instead of `referenceMasks`, and retry resolves the saved resource even after the source node receives a different mask.
- [x] Run focused generation tests; verify they fail because retry still reads `referenceMasks` or current node state.
- [x] Thread `maskResources` through render, generation-context construction, and retry resolution; make node mask editing create a new resource snapshot and update the source node only.
- [x] Run focused generation tests; verify source updates do not alter a prior result's retry mask and legacy documents still generate correctly after migration.

### Task 4: Make server limits and save feedback explicit

**Files:**
- Modify: `service/canvas_projects.go`
- Modify: `handler/canvas_projects.go`
- Modify: `router/canvas_projects_test.go`
- Modify: `web/src/app/(user)/canvas/components/canvas-sync-feedback.tsx`
- Test: `web/src/app/(user)/canvas/components/canvas-sync-feedback.test.ts`

**Interfaces:**
- Documents larger than `4 << 20` return the safe message `画板数据超过保存上限（4MB）`.
- Canvas sync feedback surfaces that exact message instead of the generic `保存失败` label.

- [x] Write failing Go route coverage that submits a document larger than 4 MiB and expects the explicit safe message.
- [x] Run the focused Go test; verify current behavior rejects it with the generic size error.
- [x] Raise the cap to 4 MiB and add a dedicated oversized-document validation error path; preserve all other document validation responses.
- [x] Write and run the failing/passing frontend feedback assertion for the precise label.

### Task 5: Verify behavior without disturbing unrelated work

**Files:**
- Modify only files listed above, plus any directly required TypeScript import adjustments.

- [x] Review `git diff --check` and the scoped diff for accidental changes.
- [x] Run `bun test`, `bun run typecheck`, `bun run build`, and `go test ./...`.
- [x] Build the Docker image only after source checks pass; do not publish or change deployment state.
