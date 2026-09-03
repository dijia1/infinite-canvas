# Canvas LOD and Render Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep 70 high-resolution image nodes and 100+ connections responsive at low zoom without changing the persisted canvas document, media ownership, or existing business behaviour.

**Architecture:** Keep `mediaId` and dimensions as the durable image identity. Introduce a canvas-only runtime media controller which decides a requested variant from screen-space node size, takes leases from a priority/deduplicating loader, and supplies temporary Object URLs to image nodes without writing them into project state. Reuse the existing UID-scoped IndexedDB keys, OSS `previewUrl`, 403 retry, and cache LRU. Rendered connections receive a conservative world-space viewport filter before memoized SVG rendering.

**Tech Stack:** Next.js, React, TypeScript, Zustand, localForage/IndexedDB, browser `AbortController`, OSS signed URLs.

**Spec:** User-approved performance analysis and implementation requirements from 2026-09-03.

## Global Constraints

- Do not migrate Canvas/WebGL or replace Zustand/IndexedDB.
- Persisted node metadata must retain only stable media identity and dimensions; signed URLs and Blob URLs remain runtime-only.
- Preserve legacy inline/data URL recovery, project save/restore, undo/redo, multiple selection, drag, resize, preview, download, masking, AI generation and 403 re-sign behaviour.
- Existing `media:<id>:v1:thumbnail|original` UID-scoped cache entries and 2 GiB LRU remain authoritative browser-cache semantics.
- AI edit requests should use server-side media lookup when every input has a stable `mediaId`; client-side original conversion remains the legacy fallback and mask upload remains client-generated.
- Every task has a failing test before production code and a separate rollback point.

## Dependency graph

```text
T1 policy + queue ──┬─> T2 cache signal support ─> T3 canvas runtime media controller ─> T4 AI media references
                    └─> T3
T5 connection viewport + memo ────────────────────────────────────────────────────────────┐
T6 wheel/resize scheduling ─────────────────────────────────────────────────────────────────┤
T7 trace, regression and performance acceptance ─────────────────────────────────────────────┘
T8 is conditional on T7 data: scale ref, graph indexes, interaction hot paths, WebGL evaluation
```

---

### Task 1 — P0: Define testable screen-space LOD policy and priority queue

**Goal:** Decide thumbnail/original/no-load from actual displayed node pixels and provide an abortable, deduplicated, priority scheduler independent of React.

**Files:**
- Create: `web/src/app/(user)/canvas/media/canvas-media-policy.ts`
- Create: `web/src/app/(user)/canvas/media/canvas-media-load-queue.ts`
- Create: `web/src/app/(user)/canvas/media/canvas-media-policy.test.ts`
- Create: `web/src/app/(user)/canvas/media/canvas-media-load-queue.test.ts`

**Interfaces:**
- `getCanvasImageVariant({ nodeWidth, nodeHeight, scale, visible, pinned }): "thumbnail" | "original" | "none"`
- `CanvasMediaLoadQueue.request({ key, priority, signal, load }): MediaLoadLease<T>` where a lease has `promise`, `release()`, and never cancels work still owned by another consumer.
- Priorities: `interactive` (AI/preview/selected), `visible-original`, `visible-thumbnail`, `prefetch`.

**State and lifecycle:**
- Screen size is `max(width * scale, height * scale)`; no fixed zoom threshold.
- A pending item is discarded before start when its final lease releases or aborts.
- A running item receives a shared `AbortSignal`; it aborts only when the final consumer releases.
- Same key shares one queue item; a later higher-priority request raises its priority rather than duplicating a fetch.

**TDD steps:**
- [ ] Write failing policy tests for offscreen, low-pixel thumbnail, high-pixel original, and pinned original precedence.
- [ ] Run the policy test and confirm it fails because the module is absent.
- [ ] Add the minimal pure policy implementation and verify green.
- [ ] Write failing queue tests for priority ordering, same-key dedupe, consumer release, queued cancellation, running cancellation and priority promotion.
- [ ] Run queue tests red, implement queue, run green.

**Verification:** `bun test web/src/app/'(user)'/canvas/media/canvas-media-policy.test.ts web/src/app/'(user)'/canvas/media/canvas-media-load-queue.test.ts`

**Rollback:** delete the new `media/` files; no caller changes exist yet.

---

### Task 2 — P0: Make existing media reads abort-aware without changing cache keys

**Goal:** Allow the queue to stop obsolete remote original/preview downloads while preserving 403 re-sign and same-key deduplication.

**Files:**
- Modify: `web/src/services/image-blob.ts`
- Modify: `web/src/services/image-storage.ts`
- Modify: `web/src/services/media-cache-policy.ts` only if its public signatures need an optional signal
- Test: `web/src/services/image-storage.test.ts` or focused new `image-storage-abort.test.ts`

**Interfaces:**
- Existing `loadMediaImage`/`loadMediaThumbnail` retain current callers.
- Add optional `{ signal?: AbortSignal }` load options; `fetch` receives the signal.
- Abort failures do not write Blob/index metadata and do not perform a 403 retry.

**State and lifecycle:**
- IndexedDB hit completes even when remote loading is not needed.
- Remote `403` retries once only while the signal remains live.
- The cache write occurs only after a complete non-aborted Blob is obtained.

**TDD steps:**
- [ ] Add a failing test that an aborted remote load calls fetch with a signal and does not write a cache entry.
- [ ] Add a failing test that a 403 still refreshes once, while abort does not refresh.
- [ ] Implement minimal optional-signal plumbing and verify focused tests.

**Verification:** `bun test web/src/services/image-storage*.test.ts web/src/services/media-cache-policy*.test.ts`

**Rollback:** remove optional options and restore current fetch call; cache record shape is unchanged.

---

### Task 3 — P0: Canvas runtime thumbnail-first media controller

**Goal:** Replace canvas-wide original hydration with runtime variant leases while keeping canvas documents and node metadata stable.

**Files:**
- Create: `web/src/app/(user)/canvas/media/use-canvas-image-resource.ts`
- Create: `web/src/app/(user)/canvas/media/use-canvas-image-resources.ts`
- Modify: `web/src/services/canvas-image-hydration.ts`
- Modify: `web/src/app/(user)/canvas/components/canvas-node.tsx`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`
- Test: `web/src/app/(user)/canvas/media/use-canvas-image-resources.test.ts`
- Test: `web/src/services/canvas-image-hydration.test.ts`

**Interfaces:**
- Canvas nodes receive an ephemeral `imageSource` and requested variant; `node.metadata.content` is not mutated for normal remote media merely to display an image.
- Controller receives visible node IDs, current viewport scale, selected/preview/mask/AI pin IDs, and a media-access resolver returning both `url` and `previewUrl`.
- Existing legacy nodes without `mediaId` keep current recovery via `content`/temporary storage.

**State and lifecycle:**
- Visible low-pixel remote node → thumbnail lease and `previewUrl`.
- Visible high-pixel or pinned remote node → original lease and original URL.
- Original load succeeds only if its generation/lease still matches; stale completion releases its Object URL and cannot overwrite a newer thumbnail/original decision.
- On downgrade, first render the already available thumbnail, then release original in a post-commit effect only when no other node/consumer uses that `storageKey`.
- Offscreen nodes release both runtime leases; IndexedDB remains cached and LRU works normally.
- Use existing `loadMediaThumbnail`, `loadMediaImage`, `releaseImageObjectURL`, `previewUrl`, cache keys and 403 retry rather than duplicating storage code.

**TDD steps:**
- [ ] Add failing tests for low-zoom thumbnail only, selected original promotion, safe original-to-thumbnail downgrade, stale completion rejection and shared-media reference counting.
- [ ] Add failing hydration regression proving legacy Blob/data URL nodes still restore.
- [ ] Implement runtime controller, then adapt node rendering without persisting Blob URLs.
- [ ] Confirm project serialization still removes transient URLs and stable `mediaId` remains unchanged.

**Verification:**
`bun test web/src/app/'(user)'/canvas/media web/src/services/canvas-image-hydration.test.ts web/src/services/canvas-project-document.test.ts`

**Rollback:** restore previous `hydrateCanvasImages` use in `canvas-client-page.tsx`; durable project data and IndexedDB keys are untouched.

---

### Task 4 — P0: Avoid browser original decode for stable-media AI inputs

**Goal:** For edit requests whose reference images all have `mediaId`, let the backend read authorized originals from its local/OSS storage directly; retain browser multipart/base64 flow for legacy or locally-only images and client-generated masks.

**Files:**
- Modify: `web/src/services/api/image.ts`
- Modify: `web/src/app/(user)/canvas/components/canvas-node-generation.ts`
- Modify: `handler/ai.go`
- Modify: `service/image_tasks.go`
- Modify: `service/media.go` or `service/image_store.go`
- Test: `web/src/services/api/image.test.ts`
- Test: `handler/ai_test.go`
- Test: `service/image_tasks_test.go`

**Interfaces:**
- Edit request accepts ordered `referenceMediaIds[]` alongside optional multipart `mask`.
- The service resolves media by ID, checks ownership, reads bytes using its existing image store, and builds task inputs in the same original order.
- A request cannot mix server media references with browser `image` files; the client selects one mode atomically.

**State and lifecycle:**
- Media IDs are stable and never signed URLs; backend reads private OSS via its configured store.
- Mask remains client-rasterized PNG and is uploaded only when present.
- Any reference lacking a `mediaId` uses existing browser local cache → Base64/File fallback unchanged.

**TDD steps:**
- [ ] Add failing handler/service tests for ordered, authorized media IDs, unauthorized media, missing media and mask pairing.
- [ ] Add a failing browser API test proving stable media references do not invoke `imageToDataUrl`.
- [ ] Implement service resolution and API selection; verify legacy multipart tests still pass.

**Verification:** `go test ./handler ./service && bun test web/src/services/api/image.test.ts web/src/app/'(user)'/canvas/components/canvas-node-generation.test.ts`

**Rollback:** clients can return to multipart automatically; server endpoint remains backwards compatible.

---

### Task 5 — P1: Memoize and conservatively viewport-cull SVG connections

**Goal:** Avoid rendering/recomputing connections that cannot affect the viewport, without hiding curves that cross the viewport or breaking selection/cutting.

**Files:**
- Modify: `web/src/app/(user)/canvas/utils/canvas-connection-geometry.ts`
- Modify: `web/src/app/(user)/canvas/components/canvas-connections.tsx`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`
- Test: `web/src/app/(user)/canvas/utils/canvas-connection-geometry.test.ts`
- Test: `web/src/app/(user)/canvas/components/canvas-connections.test.tsx`

**Interfaces:**
- Add pure `connectionIntersectsViewport(from, to, viewportWorldBounds, padding)` using a conservative cubic control-point bounding box.
- `ConnectionPath` becomes `React.memo`; its comparator uses connection identity, endpoint data references and display state.

**State and lifecycle:**
- Keep selected, active connection creation and pending-cut paths rendered regardless of viewport.
- Cutting still evaluates the full graph, so offscreen lines retain correct edit semantics.

**TDD steps:**
- [ ] Add failing geometry tests for fully outside, endpoint inside, curve-crossing and padded intersections.
- [ ] Add render test proving unchanged path props do not rerender.
- [ ] Implement filter/memo and run focused tests.

**Verification:** `bun test web/src/app/'(user)'/canvas/utils/canvas-connection-geometry.test.ts web/src/app/'(user)'/canvas/components/canvas-connections.test.tsx`

**Rollback:** remove connection filter and memo wrapper; no persistence changes.

---

### Task 6 — P1: Coalesce wheel zoom and resize persistence

**Goal:** Keep frame-rate interaction updates out of repeated project serialization while retaining exact final positions, undo/redo, and save semantics.

**Files:**
- Modify: `web/src/app/(user)/canvas/components/infinite-canvas.tsx`
- Modify: `web/src/app/(user)/canvas/components/canvas-node.tsx`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`
- Modify: `web/src/app/(user)/canvas/hooks/use-canvas-history.ts` only if a scoped resize transaction is needed
- Test: `web/src/app/(user)/canvas/components/infinite-canvas.test.tsx`
- Test: `web/src/app/(user)/canvas/components/canvas-node.test.tsx`
- Test: `web/src/app/(user)/canvas/hooks/use-canvas-history.test.ts`

**State and lifecycle:**
- Wheel events update a latest-viewport ref and emit one parent update per animation frame, preserving cursor anchor from the latest event.
- Resize begins a history/persistence transaction, updates visual dimensions at most once per frame, and commits/resumes once on mouseup/cancel/blur.

**TDD steps:**
- [ ] Add failing tests for wheel-event coalescing and final-anchor correctness.
- [ ] Add failing resize test showing many mousemove events create one final history/save transaction.
- [ ] Implement separately, verify drag/undo/redo regression tests.

**Verification:** `bun test web/src/app/'(user)'/canvas/components/infinite-canvas.test.tsx web/src/app/'(user)'/canvas/components/canvas-node.test.tsx web/src/app/'(user)'/canvas/hooks/use-canvas-history.test.ts`

**Rollback:** restore existing direct callbacks; persisted document format is unchanged.

---

### Task 7 — P1: Regression and browser performance acceptance

**Goal:** Prove behaviour and measure the target scenario before deciding on higher-risk work.

**Files:**
- Modify only focused regression tests from Tasks 1–6.
- Optional Create: `docs/performance/canvas-70-images-acceptance.md` with reproducible DevTools steps, no runtime telemetry in production.

**Automated verification:**
- [ ] `bun test`
- [ ] `bun run typecheck`
- [ ] `bun run build`
- [ ] `go test ./...`
- [ ] `docker compose -f docker-compose.local.yml build app`

**Manual Chrome acceptance:**
- [ ] Use a copy of a canvas with 70 real high-resolution images and 100+ lines; capture cold-cache and warm-cache traces.
- [ ] At full overview, Network shows preview URLs for normal nodes and originals only for selected/high-detail/preview/download/AI resources.
- [ ] Record 10 seconds each of pan, wheel zoom, selection drag and resize. Compare FPS, Long Tasks over 50ms, Image Decode/RasterTask, React commit duration and process memory against baseline.
- [ ] Inspect IndexedDB thumbnail/original keys and ensure LRU, 403 refresh and account isolation still work.

**Rollback:** release each task independently; no database migration is required.

---

### Task 8 — P2, data-gated follow-up

Do not implement until Task 7 traces identify the remaining dominant cost.

- Decouple `CanvasNode` resize scale from zoom render props if React Profiler shows all image nodes committing on zoom.
- Build node/batch/adjacency indexes if interaction traces show `find()`/selection/cutting as a material hot path.
- Add spatial indexing only if hundreds-to-thousands of nodes require it.
- Consider Canvas/WebGL only if media LOD, queueing, SVG culling/memoization and interaction scheduling still fail the measured target.

