# Code Simplification and Configuration Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove obsolete synchronous image-generation code and legacy UI styles, then consolidate provider helpers and frontend generation configuration without changing current async generation, Portal, or OSS behavior.

**Architecture:** The asynchronous `ImageGenerationTask` Worker is the only active image execution path. Provider-specific implementations share only small request-normalization utilities inside `ai/providers`. Frontend node settings are resolved by a single pure function; browser persistence normalizes historical configuration rather than making legacy model fields part of the current request model.

**Tech Stack:** Go, Gin, GORM, Next.js, React, TypeScript, Zustand, Ant Design, Bun.

**Spec:** `docs/superpowers/specs/2026-08-27-code-simplification-design.md`

## Global Constraints

- Preserve the asynchronous image-task API, Worker retry/lease behavior, Portal authorization, OSS media handling, and provider configuration stored by administrators.
- Do not change public HTTP routes, database schema, or existing stored canvas JSON.
- Do not add dependencies, global stores, generic provider abstractions, or a new persistence layer.
- Historical browser configuration must load without errors; legacy model fields may be discarded because backend provider instances own model selection.
- Keep the canvas client page, image-storage service, Worker, and material drawers structurally intact.

---

### Task 1: Delete inactive synchronous image-generation and stale styles

**Files:**

- Modify: `ai/registry.go`, `service/settings.go`, `ai/providers/maizi.go`, `ai/providers/doubao_seedream.go`, `ai/providers/maizi_test.go`, `web/src/app/globals.css`
- Test: existing `ai/providers/*_test.go`, `service/*_test.go`

**Interfaces:** Removes the internal-only `ai.ImageGenerator` and `ai.ImageEditor` interfaces plus `service.GenerateImages` and `service.EditImages`. Keeps `ai.ImageResult`, `ai.ImageReference`, `persistGeneratedImages`, and `resolveProviderForID` because the task Worker and video path use them.

- [ ] **Step 1: Record the active image execution contract**

Run:

```bash
rg -n "CreateImageTask\(|AIImagesGenerations|AIImagesEdits|persistGeneratedImages" handler service router
```

Expected: image routes create persistent tasks and Worker code still uses `persistGeneratedImages`.

- [ ] **Step 2: Remove only sync-only interfaces and wrappers**

Delete these symbols and their direct tests:

```go
type ImageGenerator interface { GenerateImage(context.Context, ImageRequest) ([]ImageResult, error) }
type ImageEditor interface { EditImage(context.Context, ImageRequest, []ImageReference) ([]ImageResult, error) }
func GenerateImages(context.Context, ai.ImageRequest) ([]ai.ImageResult, error)
func EditImages(context.Context, ai.ImageRequest, []ai.ImageReference) ([]ai.ImageResult, error)
```

Remove `GenerateImage`, `EditImage`, and URL-to-result wrapper methods from the MaiziAI and Doubao providers. Retain every `ImageTaskProvider` method used by `image_task_worker.go`.

- [ ] **Step 3: Remove confirmed unused CSS blocks**

Delete only selector groups with no source caller: `.ai-title-aurora`, `.prompt-filter-tag`, `.hover-scrollbar`, `.hover-scrollbar-hint`, and `.canvas-composer-*` plus their private keyframes/media rules. Do not delete mixed `canvas-control-select` rules that are still used by `canvas-size-picker.tsx`.

- [ ] **Step 4: Verify the deletion**

Run:

```bash
rg -n "GenerateImages|EditImages|ImageGenerator|ImageEditor|ai-title-aurora|prompt-filter-tag|hover-scrollbar|canvas-composer-" ai service web/src --glob '!**/docs/**'
go test ./ai/... ./service/... -count=1
```

Expected: no deleted symbol or selector remains; focused Go tests pass.

### Task 2: Give shared provider request utilities a neutral home

**Files:**

- Create: `ai/providers/image_request_helpers.go`
- Modify: `ai/providers/maizi.go`, `ai/providers/doubao_seedream.go`, `ai/providers/maizi_test.go`, `ai/providers/doubao_seedream_test.go`

**Interfaces:** `cloneImageRequestOptions`, `imageRequestOptionString`, and `marshalRedactedJSON` remain package-private. No provider imports another provider implementation.

- [ ] **Step 1: Add a failing helper test**

Add a provider-package test that verifies cloned JSON options are independent and that marshalled summaries redact `data:` image input while retaining non-image fields:

```go
options := ai.ImageRequestOptions{"resolution": json.RawMessage(`"2k"`)}
clone := cloneImageRequestOptions(options)
clone["resolution"] = json.RawMessage(`"4k"`)
if string(options["resolution"]) != `"2k"` { t.Fatal("source options mutated") }
```

- [ ] **Step 2: Run the helper test and confirm it fails before extraction**

Run:

```bash
go test ./ai/providers -run TestMarshalRedactedJSON -count=1
```

Expected: compilation fails because `marshalRedactedJSON` does not yet exist; `cloneImageRequestOptions` remains temporarily defined inside `maizi.go` until the extraction step.

- [ ] **Step 3: Move neutral helpers without changing request semantics**

Create `image_request_helpers.go` in package `providers`; move cloning, option string lookup and redacted JSON encoding into it. Rename `marshalMaiziRedactedJSON` to `marshalRedactedJSON`; update both providers. Do not move provider request bodies, endpoint paths, or schema validation.

- [ ] **Step 4: Verify both adapters**

Run:

```bash
go test ./ai/providers -count=1
```

Expected: MaiziAI and Doubao schema/request-summary tests pass.

### Task 3: Make node generation configuration and readiness capability-specific

**Files:**

- Modify: `web/src/app/(user)/canvas/utils/canvas-generation-utils.ts`, `web/src/app/(user)/canvas/utils/canvas-generation-utils.test.ts`, `web/src/app/(user)/canvas/components/canvas-config-node-panel.tsx`, `web/src/app/(user)/canvas/components/canvas-node-prompt-panel.tsx`, `web/src/app/(user)/canvas/hooks/use-canvas-generation.ts`, `web/src/stores/use-config-store.ts`
- Test: `web/src/stores/use-config-store.test.ts` (create), existing canvas generation utility and hook tests

**Interfaces:** `buildGenerationConfig(config, node, fallbackConfig)` replaces the duplicate panel-only builders and no longer accepts unused `mode`. `isAiConfigReady(capability)` accepts only `"image" | "imageEdit" | "video"`.

- [ ] **Step 1: Write failing behavior tests**

Add tests proving:

```ts
assert.equal(isCapabilityReady({ imageAvailable: false, imageEditable: false, videoAvailable: true }, "image"), false);
assert.equal(isCapabilityReady({ imageAvailable: true, imageEditable: false, videoAvailable: true }, "imageEdit"), false);
assert.equal(isCapabilityReady({ imageAvailable: true, imageEditable: true, videoAvailable: false }, "imageEdit"), true);
```

Add a configuration test confirming a node-local provider snapshot wins over changed global provider options and both panels use the shared resolver.

- [ ] **Step 2: Run tests to establish the failing state**

Run:

```bash
cd web && bun test src/stores/use-config-store.test.ts 'src/app/(user)/canvas/utils/canvas-generation-utils.test.ts'
```

Expected: readiness assertions fail because object input currently treats any available capability as ready; panel import assertions fail before duplication is removed.

- [ ] **Step 3: Extract the resolver and update callers**

Move all node/local-provider precedence, output normalization, resolution normalization and count handling into `buildGenerationConfig`. Make both panels call it. In the generation controller, check `imageEdit` after reference images are known, `image` for text-to-image and `video` for video; retries select `imageEdit` when the saved generation type is `edit`.

- [ ] **Step 4: Verify frontend behavior**

Run:

```bash
cd web && bun test src/stores/use-config-store.test.ts 'src/app/(user)/canvas/utils/canvas-generation-utils.test.ts' 'src/app/(user)/canvas/hooks/use-canvas-generation.test.ts' && bun run typecheck
```

Expected: capability, provider snapshot, retry and TypeScript checks pass.

### Task 4: Remove obsolete frontend model fields with persisted-state normalization

**Files:**

- Modify: `web/src/lib/ai-config.ts`, `web/src/stores/use-config-store.ts`, `web/src/stores/use-config-store.test.ts`, `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`, `web/src/app/(user)/canvas/hooks/use-canvas-generation.ts`, `web/src/app/(user)/canvas/hooks/use-canvas-generation.test.ts`, `web/src/app/(user)/canvas/types.ts`, `web/src/app/(user)/canvas/utils/canvas-generation-utils.test.ts`

**Interfaces:** `AiConfig` no longer exposes `model`, `imageModel`, `videoModel`, `textModel`, `models`, or `systemPrompt`. `normalizePersistedAiConfig(input)` returns a complete current configuration. Historical canvas metadata may contain `model`, but no new node writes it and no request reads it.

- [ ] **Step 1: Write migration and request-shape tests**

Add tests proving legacy persisted input is accepted and its current values survive:

```ts
assert.deepEqual(normalizePersistedAiConfig({ model: "old", imageModel: "old-image", size: "16:9", resolution: "1024x1024" }), {
  ...defaultConfig,
  size: "16:9",
  resolution: "1k",
});
```

Add assertions that newly created config/image/video nodes omit `metadata.model` and generated request configs have no `model` property.

- [ ] **Step 2: Run tests and confirm they fail before removal**

Run:

```bash
cd web && bun test src/stores/use-config-store.test.ts 'src/app/(user)/canvas/hooks/use-canvas-generation.test.ts' 'src/app/(user)/canvas/utils/canvas-generation-utils.test.ts'
```

Expected: new assertions fail because legacy model values are still retained and written.

- [ ] **Step 3: Normalize persisted state and delete active legacy-field use**

Use Zustand persistence version/migration or an equivalent `merge` normalizer to replace stored config with `normalizePersistedAiConfig`. Remove model-field production reads/writes from node creation, config resolution, image generation, retry and video metadata. Keep old `metadata.model` structurally tolerated by TypeScript only if it is needed to read existing canvas data; do not copy it into fresh nodes.

- [ ] **Step 4: Run full regression verification**

Run:

```bash
go test ./... -count=1
cd web && bun test && bun run typecheck && bun run build
git diff --check
```

Expected: all suites, typecheck, production build and diff validation pass.
