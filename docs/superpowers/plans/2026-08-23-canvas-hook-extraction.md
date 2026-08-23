# Canvas Hook Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the canvas page's history, pointer interactions, and image-generation orchestration into cohesive hooks without changing existing canvas behavior, browser persistence, or API contracts.

**Architecture:** `canvas-client-page.tsx` remains the composition layer and owner of render-only state. Each hook owns only the refs, effects, callbacks, and derived state belonging to one behavioral boundary, and receives the existing React state setters plus small, typed dependency groups. Existing pure rules in `canvas-generation-utils.ts`, `canvas-graph-utils.ts`, and `canvas-image-hydration.ts` remain the shared lower layers; no new store, network endpoint, or request format is introduced.

**Tech Stack:** Next.js, React hooks, TypeScript, Zustand, Bun test, existing canvas utilities.

**Spec:** No separate specification; this plan implements the approved extraction order from the canvas simplification review.

## Global Constraints

- Work directly on local `main`, as explicitly authorized by the user.
- Preserve all current canvas behavior, persisted project shape, backend API calls, and AI provider request formats.
- Do not change the synchronous AI task model in this refactor; task persistence is a future feature and must not be mixed into this extraction.
- Reuse existing pure utilities and services; do not add packages, a global store, or forwarding-only modules.
- Keep `canvas-client-page.tsx` as the integration point for visual state and JSX.
- Use test-first development for each production hook and run the focused test suite before moving to the next task.
- Preserve the existing `resetInterruptedGeneration` behavior on page restore.
- The existing Bun suite has no React hook renderer or DOM test runtime. Each hook file may export one non-React controller/core beside its hook so `node:test` can verify state transitions with injected setters and scheduler functions; the hook remains the only React-facing API.

---

### Task 1: Extract canvas history management

**Files:**
- Create: `web/src/app/(user)/canvas/hooks/use-canvas-history.ts`
- Create: `web/src/app/(user)/canvas/hooks/use-canvas-history.test.ts`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`

**Interfaces:**
- Consumes: an explicit `snapshot` value `{ nodes, connections, backgroundMode, showImageInfo }`, React state setters, and `projectLoaded`.
- Produces: `{ canUndo, canRedo, undo, redo, pause, resume, reset, replaceBaseline, getRetainedHistory, isPausedRef, isApplyingRef }`, where `getRetainedHistory()` returns `{ history: { past, future }, lastHistory }` for `cleanupAssetImages({ history, lastHistory, extra })`.
- Snapshot shape: `{ nodes, connections, backgroundMode, showImageInfo }`.

- [ ] **Step 1: Write failing history tests**

Create tests for an exported `createCanvasHistoryController` in the same hook file. Inject a scheduler with `schedule`, `clear`, and synchronous `flush` functions so the test never waits for wall-clock time:

```ts
test("commits one debounced snapshot and clears redo after a new edit", async () => {
  // establish baseline -> record two changes inside 180ms -> flush -> undo -> record -> flush
  // expect one undo entry and no redo entry after the new edit
});

test("does not record changes while paused and resumes from the final drag state", async () => {
  // pause -> record intermediate drag snapshots -> resume -> record final snapshot -> flush
  // expect only the pre-drag baseline to be undoable
});

test("bounds undo history to fifty snapshots and reset clears both stacks", () => {
  // record 51 distinct snapshots after a baseline -> assert 50 past entries -> reset -> assert undo/redo are disabled
});
```

- [ ] **Step 2: Run the history test and verify it fails**

Run:

```bash
docker run --rm -v /Users/Admin/codexprogram/infinite-canvas/web:/workspace -w /workspace infinite-canvas:oss-sso-local bun test 'src/app/(user)/canvas/hooks/use-canvas-history.test.ts'
```

Expected: FAIL because `use-canvas-history.ts` does not exist.

- [ ] **Step 3: Implement the smallest history hook**

Move only the following responsibilities out of the page: explicit snapshot observation, 180ms timer ownership, 50-entry retention, pause/apply guards, undo/redo stacks, baseline replacement, retained-history access, and cleanup on unmount. Keep selection/context-menu reset as a page callback invoked after a snapshot is applied.

```ts
export function useCanvasHistory<TSnapshot>({
  snapshot,
  applySnapshot,
  isReady,
}: UseCanvasHistoryOptions<TSnapshot>): UseCanvasHistoryResult<TSnapshot> {
  // refs own past/future/baseline/timer; an effect observes snapshot changes.
}
```

- [ ] **Step 4: Integrate the hook into the page**

Replace `historyRef`, `lastHistoryRef`, `historyCommitTimerRef`, `applyingHistoryRef`, `historyPausedRef`, `historyState`, `applyHistory`, `undoCanvas`, and `redoCanvas` with the hook. Route node dragging through `pause()` before movement and `resume()` after final position commit. Keep project hydration responsible for `replaceBaseline(restoredSnapshot)` before setting `projectLoaded`. Keep the project-persistence effect guarded by `isPausedRef.current || isApplyingRef.current`, and pass `getRetainedHistory()` to `cleanupAssetImages` so undo snapshots continue protecting cached images.

- [ ] **Step 5: Run focused verification**

Run:

```bash
docker run --rm -v /Users/Admin/codexprogram/infinite-canvas/web:/workspace -w /workspace infinite-canvas:oss-sso-local bun test 'src/app/(user)/canvas/hooks/use-canvas-history.test.ts'
docker run --rm -v /Users/Admin/codexprogram/infinite-canvas/web:/workspace -w /workspace infinite-canvas:oss-sso-local bun run typecheck
```

Expected: history tests pass; typecheck has no errors attributable to the new hook.

### Task 2: Extract pointer interactions

**Files:**
- Create: `web/src/app/(user)/canvas/hooks/use-canvas-interactions.ts`
- Create: `web/src/app/(user)/canvas/hooks/use-canvas-interactions.test.ts`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`

**Interfaces:**
- Consumes: canvas element ref, node/connection refs, viewport ref, selected-node ref/setter, context/dialog/toolbar/hover setters, history pause/resume, `screenToCanvas`, `message`, and existing graph utilities.
- Produces: pointer event handlers, interaction state (`selectionBox`, `cutConnectionState`, `connectingParams`, `connectionTargetNodeId`, `pendingConnectionCreate`, `mouseWorld`, `isNodeDragging`), plus `createConnectedNode`, `cancelPendingConnectionCreate`, and `finishNodeDrag` cleanup.
- Uses: `normalizeConnection`, `isHiddenBatchConnectionEndpoint`, and `segmentHitsConnection` without duplicating graph rules.

- [ ] **Step 1: Write failing interaction tests**

Create focused tests for an exported controller/core in the same file, using mutable refs and synchronous setter doubles:

```ts
test("node drag moves every selected batch child once and commits only on pointer release", () => {
  // start node drag -> pointer move -> release
  // expect selected node and batch children translated by the same world delta
});

test("connection creation normalizes config handles, opens pending creation, and rejects duplicates", () => {
  // request a config-handle connection twice, then create a child node
  // expect one normalized connection and one pending-create lifecycle
});

test("cut mode ignores hidden batch endpoints and removes only intersected visible connections", () => {
  // sample a cut segment against visible and collapsed-batch connections
  // expect only visible intersections selected for deletion
});
```

- [ ] **Step 2: Run the interaction test and verify it fails**

Run:

```bash
docker run --rm -v /Users/Admin/codexprogram/infinite-canvas/web:/workspace -w /workspace infinite-canvas:oss-sso-local bun test 'src/app/(user)/canvas/hooks/use-canvas-interactions.test.ts'
```

Expected: FAIL because `use-canvas-interactions.ts` does not exist.

- [ ] **Step 3: Implement and migrate one interaction boundary at a time**

Move in this order, retaining existing names and behavior: node drag plus `mousemove`/`mouseup` listeners; box selection plus `pointermove`/`pointerup`/`pointercancel`/`blur` termination; connection targeting, pending creation, and child creation; then Ctrl-cut path collection and deletion. The hook owns pointer-specific refs, `nodeDraggingRef`, and animation frame cleanup. On release it resumes history before committing the final position so a drag yields one snapshot. The page keeps JSX callbacks, clipboard/project actions, and visual dialog rendering.

- [ ] **Step 4: Integrate only through typed dependencies**

Pass setters and narrow callbacks (`screenToCanvas`, `onConnectionCreated`, `onNodeClick`) rather than the page component's full state object. Return all states consumed by JSX and do not create a new context or make interaction state global.

- [ ] **Step 5: Run focused verification**

Run:

```bash
docker run --rm -v /Users/Admin/codexprogram/infinite-canvas/web:/workspace -w /workspace infinite-canvas:oss-sso-local bun test 'src/app/(user)/canvas/hooks/use-canvas-interactions.test.ts' 'src/app/(user)/canvas/utils/canvas-graph-utils.test.ts'
docker run --rm -v /Users/Admin/codexprogram/infinite-canvas/web:/workspace -w /workspace infinite-canvas:oss-sso-local bun run typecheck
```

Expected: interaction and graph tests pass; typecheck has no errors attributable to the extraction.

### Task 3: Extract image-generation orchestration

**Files:**
- Create: `web/src/app/(user)/canvas/hooks/use-canvas-generation.ts`
- Create: `web/src/app/(user)/canvas/hooks/use-canvas-generation.test.ts`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`

**Interfaces:**
- Consumes: nodes/connections refs, effective AI config, `isAiConfigReady`, `openConfigDialog`, `message`, node/connection setters, selection/dialog setters, `uploadImage`, `uploadMediaFile`, `resolveImageUrl`, request functions, `fitNodeSize`, node defaults/id creation, and existing generation/media utilities.
- Produces: `generateNode`, `retryNode`, `generateImageFromTextNode`, `generateAngleNode`, `runningNodeId`, and generation dialog state transitions.
- Uses: `buildGenerationConfig`, `buildImageGenerationMetadata`, `buildNodeGenerationContext`, `hydrateNodeGenerationContext`, `buildNodeChatMessages`, `findRetrySourceNode`, `getGenerationCount`, `referenceUrl`, `resolveMetadataReferences`, `sourceNodeReferenceImages`, `videoMetadata`, `imageMetadata`, and the existing request APIs.

- [ ] **Step 1: Write failing generation tests**

Create tests for an exported `createCanvasGenerationController` in the same hook file. Inject deterministic request/upload doubles and mutable state refs; `useCanvasGeneration` only adapts React state, refs, and effects around this non-React core:

```ts
test("creates a batch root, three loading children, and writes media metadata after each success", async () => {
  // config count 3 -> expect one root, three children, three root-to-child connections, three requests
  // resolve all requests -> expect every child to receive independent mediaId/storageKey metadata
});

test("marks only a failed batch child as error while preserving successful children and root status", async () => {
  // resolve one request and reject one -> assert child and batch-root final statuses match current behavior
});

test("retries an image from its upstream config node using persisted image generation metadata", async () => {
  // retry child -> assert request config/prompt/reference metadata are reconstructed from utilities
});
```

- [ ] **Step 2: Run the generation test and verify it fails**

Run:

```bash
docker run --rm -v /Users/Admin/codexprogram/infinite-canvas/web:/workspace -w /workspace infinite-canvas:oss-sso-local bun test 'src/app/(user)/canvas/hooks/use-canvas-generation.test.ts'
```

Expected: FAIL because `use-canvas-generation.ts` does not exist.

- [ ] **Step 3: Implement the generation hook without changing transport semantics**

Move image/edit/video dispatch, angle generation, batch-root and child updates, media cache writes, retry source resolution, status/error handling, and `runningNodeId` ownership. Preserve the current API request sequence and error strings. Do not add background jobs, polling state, or a database task model.

- [ ] **Step 4: Integrate page generation entry points**

Replace `handleGenerate`, `handleRetryNode`, `generateImageFromTextNode`, and `generateAngleNode` with hook callbacks. Keep crop logic, dialogs, and popovers in the page, passing their close/open setters into the hook as dependencies. Ensure page refresh still invokes `resetInterruptedGeneration` during hydration exactly as before.

- [ ] **Step 5: Run focused verification**

Run:

```bash
docker run --rm -v /Users/Admin/codexprogram/infinite-canvas/web:/workspace -w /workspace infinite-canvas:oss-sso-local bun test 'src/app/(user)/canvas/hooks/use-canvas-generation.test.ts' 'src/app/(user)/canvas/utils/canvas-generation-utils.test.ts' 'src/services/canvas-image-hydration.test.ts'
docker run --rm -v /Users/Admin/codexprogram/infinite-canvas/web:/workspace -w /workspace infinite-canvas:oss-sso-local bun run typecheck
```

Expected: generation/media tests pass; typecheck has no errors attributable to the extraction.

### Task 4: Integration review and production verification

**Files:**
- Modify: only files identified by review findings

**Interfaces:**
- Consumes: all three extracted hook interfaces.
- Produces: a smaller composition page with no duplicated history, pointer, or generation ownership.

- [ ] **Step 1: Inspect the final diff for duplicated or orphaned ownership**

Run:

```bash
git diff --check
rg -n 'historyRef|historyCommitTimerRef|handleGlobalMouseMove|handleGlobalPointerMove|handleGenerate|handleRetryNode|requestEdit|requestGeneration|requestImageQuestion|requestVideoGeneration' 'web/src/app/(user)/canvas/[id]/canvas-client-page.tsx'
```

Expected: no old history/pointer/generation implementation or direct generation request remains in the page; only hook wiring or intentional JSX entry-point references remain.

- [ ] **Step 2: Run full frontend and backend verification**

Run:

```bash
docker run --rm -v /Users/Admin/codexprogram/infinite-canvas/web:/workspace -w /workspace infinite-canvas:oss-sso-local bun test
docker run --rm -v /Users/Admin/codexprogram/infinite-canvas/web:/workspace -w /workspace infinite-canvas:oss-sso-local bun run build
```

Expected: all existing frontend tests and the production frontend build pass. The extraction does not touch Go or Docker code, so those unrelated suites are intentionally excluded.

- [ ] **Step 3: Perform adversarial review**

Use a fresh reviewer to inspect the complete diff specifically for stale closures, timer/listener leaks, React Strict Mode behavior, history state loss while dragging, batch-node interaction regressions, partial AI failures, and page-refresh recovery. Fix any Critical or Important finding, then rerun the relevant focused test and one scoped re-review.
