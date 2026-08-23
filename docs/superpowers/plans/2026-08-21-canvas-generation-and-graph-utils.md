# Canvas Generation and Graph Utilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the remaining pure generation and graph rules from the canvas page without changing canvas behavior, persisted data, or public APIs.

**Architecture:** Add two dependency-free utility modules below `web/src/app/(user)/canvas/utils/`. `canvas-generation-utils.ts` owns AI-generation configuration, reference-image metadata, retry-source traversal, and batch-generation metadata. `canvas-graph-utils.ts` owns connection normalization and visibility rules for batch nodes and endpoints. React callbacks, network requests, state mutation, media restoration, and JSX remain in `canvas-client-page.tsx`.

**Tech Stack:** TypeScript, Bun test runner using `node:test`, Next.js, Zustand, existing canvas types.

**Spec:** User-approved scope from this task: `canvas-generation-utils.ts` and `canvas-graph-utils.ts` extraction.

## Global Constraints

- Preserve all current canvas interaction, AI-generation, retry, batch visibility, and connection behavior.
- Do not add dependencies, stores, runtime abstraction layers, or new persistence formats.
- Utility modules may import types and existing pure helpers, but must not import React, stores, request APIs, browser APIs, or media services.
- Keep async `resolveMetadataReferences` in the page because it performs image-cache/media resolution and is not a pure utility.
- Keep `applyNodeConfigPatch` in the page for this iteration because it combines metadata changes with visual node geometry.
- Keep the existing first-stage uncommitted geometry/media extraction intact; do not amend, revert, or stage it as part of these tasks.
- “批次显示判断” is implemented in `canvas-graph-utils.ts`, rather than generation utilities, because both the viewport and connection-rendering paths consume it.

---

## Target file structure

- Create: `web/src/app/(user)/canvas/utils/canvas-generation-utils.ts` — pure AI-generation and retry rules.
- Create: `web/src/app/(user)/canvas/utils/canvas-generation-utils.test.ts` — unit tests for generation utility behavior.
- Create: `web/src/app/(user)/canvas/utils/canvas-graph-utils.ts` — pure graph connection and batch-visibility rules.
- Create: `web/src/app/(user)/canvas/utils/canvas-graph-utils.test.ts` — unit tests for graph utility behavior.
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx` — import the utilities and delete only their original local definitions.

### Task 1: Extract generation and retry rules

**Files:**
- Create: `web/src/app/(user)/canvas/utils/canvas-generation-utils.ts`
- Create: `web/src/app/(user)/canvas/utils/canvas-generation-utils.test.ts`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx:2742-2866`

**Interfaces:**

```ts
export function buildImageGenerationMetadata(
  type: CanvasImageGenerationType,
  config: AiConfig,
  count: number,
  references: ReferenceImage[],
): CanvasNodeMetadata;

export function referenceUrl(image: ReferenceImage): string | undefined;
export function getGenerationCount(count: string): number;
export function getInputSummary(inputs: NodeGenerationInput[]): { textCount: number; imageCount: number };
export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasGenerationMode, fallbackConfig: AiConfig): AiConfig;
export function resetInterruptedGeneration(nodes: CanvasNodeData[]): CanvasNodeData[];
export function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData | null;
export function sourceNodeReferenceImages(node: CanvasNodeData | null): ReferenceImage[];
export type CanvasAngleParameters = { horizontalAngle: number; pitchAngle: number; cameraDistance: number; wideAngle: boolean };
export function buildAngleLabel(params: CanvasAngleParameters): string;
export function buildAnglePrompt(params: CanvasAngleParameters): string;
```

- [ ] **Step 1: Write failing tests for generation normalization and metadata.**

  Add test cases that assert:

  ```ts
  assert.equal(getGenerationCount("-20"), 15);
  assert.equal(getGenerationCount("0"), 1);
  assert.equal(getGenerationCount("3.9"), 3);

  assert.deepEqual(buildImageGenerationMetadata("edit", config, 2, [storedReference, dataReference]), {
    generationType: "edit",
    size: config.size,
    resolution: config.resolution,
    quality: config.quality,
    count: 2,
    references: ["media:reference", "https://example.test/reference.png"],
  });
  ```

  Add cases for model selection by `image`/`video`/`text`, resolution normalization, interrupted loading status conversion, and `sourceNodeReferenceImages` returning no entry for a non-image or image without content.

- [ ] **Step 2: Write failing tests for retry-source traversal and angle strings.**

  Build a connection chain `image -> text -> config -> failed-image` and assert `findRetrySourceNode` finds the upstream config node; build a cycle without a config node and assert it returns `null`. Assert positive/negative horizontal and pitch values produce the existing Chinese labels, and assert `buildAnglePrompt` contains the label.

- [ ] **Step 3: Run the focused test before implementation.**

  Run:

  ```bash
  bun test 'src/app/(user)/canvas/utils/canvas-generation-utils.test.ts'
  ```

  Expected: failure because `canvas-generation-utils.ts` does not yet exist.

- [ ] **Step 4: Implement the minimal pure generation module.**

  Move, without rewriting their conditions or user-facing strings, these page-local functions into `canvas-generation-utils.ts`:

  ```ts
  buildImageGenerationMetadata
  referenceUrl
  getGenerationCount
  getInputSummary
  buildGenerationConfig
  resetInterruptedGeneration
  findRetrySourceNode
  sourceNodeReferenceImages
  buildAngleLabel
  buildAnglePrompt
  ```

  Use `CanvasGenerationMode` directly from `../types`; do not import `CanvasNodeGenerationMode` from a React component. Keep the module store-free by accepting `fallbackConfig` as an argument; the page passes its existing `defaultConfig` at every `buildGenerationConfig` call. Define `CanvasAngleParameters` locally in the utility instead of importing a type from the dialog component. Preserve breadth-first retry traversal and the existing visited-node guard.

- [ ] **Step 5: Replace page-local calls and remove only migrated definitions.**

  Import the named functions into `canvas-client-page.tsx`. Replace the `CanvasNodeGenerationMode` type import with the existing `CanvasGenerationMode` type from `../types` where needed. Leave `resolveMetadataReferences` and `applyNodeConfigPatch` in the page.

- [ ] **Step 6: Verify generation extraction.**

  Run:

  ```bash
  bun test 'src/app/(user)/canvas/utils/canvas-generation-utils.test.ts'
  bun run typecheck
  ```

  Expected: all focused tests and TypeScript checks pass.

### Task 2: Extract graph connection and batch-visibility rules

**Files:**
- Create: `web/src/app/(user)/canvas/utils/canvas-graph-utils.ts`
- Create: `web/src/app/(user)/canvas/utils/canvas-graph-utils.test.ts`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx:2780-2856`

**Interfaces:**

```ts
export type NormalizedConnection = Pick<CanvasConnection, "fromNodeId" | "toNodeId">;

export function normalizeConnection(
  firstNodeId: string,
  secondNodeId: string,
  nodes: CanvasNodeData[],
  firstHandleType: ConnectionHandle["handleType"],
): NormalizedConnection | null;

export function isHiddenBatchChild(
  node: CanvasNodeData,
  nodes: CanvasNodeData[],
  collapsingBatchIds?: Set<string>,
): boolean;

export function isHiddenBatchConnectionEndpoint(node: CanvasNodeData, nodes: CanvasNodeData[]): boolean;
```

- [ ] **Step 1: Write failing tests for connection normalization.**

  Build image, text, and config fixtures. Assert that missing IDs, self-connections, and two config nodes return `null`; assert a connection into a config node ends at the config node; assert a config node started from a target handle reverses direction; assert a source-handle config connection keeps config as the source.

- [ ] **Step 2: Write failing tests for batch visibility.**

  Build a root image with `imageBatchExpanded: false` and a child with `batchRootId`. Assert the child and its connection endpoint are hidden. Assert `collapsingBatchIds` temporarily makes the child visible while the root’s endpoint rule remains unchanged. Assert an absent root or missing `batchRootId` is never hidden.

- [ ] **Step 3: Run the focused test before implementation.**

  Run:

  ```bash
  bun test 'src/app/(user)/canvas/utils/canvas-graph-utils.test.ts'
  ```

  Expected: failure because `canvas-graph-utils.ts` does not yet exist.

- [ ] **Step 4: Implement the minimal pure graph module.**

  Copy the current branch order and return values of `normalizeConnection`, `isHiddenBatchChild`, and `isHiddenBatchConnectionEndpoint` into `canvas-graph-utils.ts`. Do not add duplicate-connection detection: that remains in the page callback because it depends on current state.

- [ ] **Step 5: Replace page-local calls and remove only migrated definitions.**

  Import the three graph functions into `canvas-client-page.tsx`. Retain all existing callers: connection creation, hover validation, viewport filtering, rendering filters, and cut-connection checks. Delete only the corresponding local definitions.

- [ ] **Step 6: Verify graph extraction.**

  Run:

  ```bash
  bun test 'src/app/(user)/canvas/utils/canvas-graph-utils.test.ts'
  bun run typecheck
  ```

  Expected: all focused tests and TypeScript checks pass.

### Task 3: Integration and regression verification

**Files:**
- Modify only if a verification failure proves an extraction regression.

- [ ] **Step 1: Inspect the final diff.**

  Run:

  ```bash
  git diff --check
  git diff -- web/src/app/(user)/canvas/[id]/canvas-client-page.tsx web/src/app/(user)/canvas/utils/canvas-generation-utils.ts web/src/app/(user)/canvas/utils/canvas-graph-utils.ts
  ```

  Confirm the page only replaces imports/calls and deletes the migrated pure functions.

- [ ] **Step 2: Run full frontend regression checks.**

  Run:

  ```bash
  bun run typecheck
  bun test
  ```

  Expected: type check has zero errors and all Bun tests pass.

- [ ] **Step 3: Run the production frontend build.**

  Run:

  ```bash
  docker compose build --quiet app
  ```

  Expected: application image builds successfully.

- [ ] **Step 4: Commit only with explicit user direction.**

  The working tree already contains uncommitted first-stage canvas extraction changes. Do not stage, amend, commit, or push any changes unless the user explicitly asks for that integration action.

## Self-review

- Spec coverage: Task 1 covers generation configuration, count, references, retry source, input summary, interrupted generation, and angle prompt rules. Task 2 covers connection normalization and batch visibility rules. Task 3 covers integration.
- Deliberately excluded: media resolution, node resizing, pointer interaction, history, AI request dispatch, and JSX; each has side effects or a larger interaction surface.
- Type consistency: utility APIs use existing `CanvasNodeData`, `CanvasConnection`, `CanvasGenerationMode`, `AiConfig`, and `ReferenceImage` types; the generation utility locally owns its structural `CanvasAngleParameters` type.
