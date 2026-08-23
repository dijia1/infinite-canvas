# Media Cache Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make browser media loading cache-first and variant-aware, so private uploads do not immediately re-download from OSS, while public previews remain fast and safely evictable.

**Architecture:** Retain the existing per-Portal-user localforage stores, but make `image-storage.ts` the single media-cache service. It will distinguish immutable original media (`media:<id>`) from 320px WebP previews (`preview:<id>`), provide cache-first original/preview resolvers with single-flight downloads, derive previews locally when an original Blob is already cached, and retain preview metadata for LRU eviction. Each asynchronous operation captures its Portal scope/version; components receive Blob URLs only; signed OSS URLs remain transient fetch inputs.

**Tech Stack:** Next.js, TypeScript, localforage/IndexedDB, browser Canvas/OffscreenCanvas where available, Bun tests, Go media access API unchanged.

**Spec:** User-approved cache analysis in this thread; no separate design document was requested.

## Global Constraints

- Keep Portal UID isolation for all browser state and image Blob stores.
- Do not persist signed OSS URLs or AccessKey material in the browser.
- Keep `MEDIA_STORAGE=local` fallback working through existing access endpoints.
- Do not change object keys, media IDs, upload authorization, or public/private access rules.
- Use existing localforage; do not add a cache dependency.
- Preserve `publicImageId` whenever a public image is placed on the canvas or saved into a private asset, so access recovery remains public for non-owners.
- Never revoke an Object URL only because one consumer released a cache record; revoke it only when the cache entry is actually removed or replaced.
- Preserve unrelated current worktree changes.

---

### Task 1: Cache policy and regression tests

**Files:**
- Create: `web/src/services/media-cache-policy.ts`
- Create: `web/src/services/media-cache-policy.test.ts`

**Interfaces:**
- Produces `resolveOriginal<T>()`, `resolvePreview<T>()`, and `coalesceMediaLoad<T>()`.
- `resolvePreview` checks preview first, then creates a preview from a local original, and invokes remote loading only when no local original is available.

- [x] **Step 1: Write failing tests** for cached-original/no-network, local-original-derived-preview/no-network, remote-preview fallback, and two concurrent loads sharing one remote call.
- [x] **Step 2: Run** `bun test src/services/media-cache-policy.test.ts` and verify the missing module/test failures.
- [x] **Step 3: Implement** the small dependency-injected policy functions and a keyed in-flight Promise map.
- [x] **Step 4: Re-run** the focused test until all cache-ordering assertions pass.

### Task 2: Variant-aware IndexedDB media cache

**Files:**
- Modify: `web/src/services/image-storage.ts`
- Create: `web/src/services/image-storage-cache.test.ts`

**Interfaces:**
- Produces `loadMediaImage(mediaId, remoteURL)`, `loadMediaPreview(mediaId, remotePreviewURL)`, and `createImagePreview(blob)`.
- Original cache key is `media:<id>`; preview cache key is `preview:<id>`.

- [x] **Step 1: Write failing tests** for preview key retention, cache-first original loading, local preview derivation preference, and cleanup retaining unreferenced public previews.
- [x] **Step 2: Implement** cache adapters around Task 1 policy, WebP 320px/quality 0.8 preview generation, scope-version guards, Object URL replacement cleanup, and scoped metadata tracking for preview LRU.
- [x] **Step 3: Update cleanup** so explicit media deletion still removes both variants, but generic asset/canvas cleanup does not delete public previews or in-flight entries; evict only least-recently-used previews over the configured budget.
- [x] **Step 4: Run** the policy/storage tests and `bun run typecheck`.

### Task 3: Adopt cache resolvers in consumers

**Files:**
- Modify: `web/src/app/(user)/canvas/components/asset-picker-modal.tsx`
- Modify: `web/src/app/(user)/canvas/components/public-image-drawer.tsx`
- Modify: `web/src/services/public-image-cache.ts` or remove it if superseded
- Modify: `web/src/stores/asset-storage-hydration.ts`
- Modify: `web/src/services/canvas-image-hydration.ts`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`
- Modify/add focused tests for private/public drawer and hydration services.

- [x] **Step 1: Write failing tests** covering private upload preview resolution without an OSS request, public preview cache reuse, cached public drag-to-canvas without an access request, and saving a public canvas node to private assets without losing `publicImageId`.
- [x] **Step 2: Replace** component-local remote preview logic with Task 2 cache resolvers.
- [x] **Step 3: Replace** asset/canvas recovery remote download paths with cache-first original resolution.
- [x] **Step 4: Re-run** focused media, drawer, hydration, and generation tests.

### Task 4: Integration, capacity behavior, and adversarial review

**Files:**
- Modify only files required by findings from Tasks 1–3.
- Add/modify tests for discovered regressions.

- [x] **Step 1: Run** typecheck, relevant Bun tests, Go tests, and a clean Docker production build.
- [ ] **Step 2: Manually verify** the local Portal page: private upload remains visible without a second OSS read; forced refresh restores from IndexedDB; public list falls back to OSS only after a local miss.
- [x] **Step 3: Perform adversarial review** for user scope changes, expired signatures, absent/malformed images, concurrent loads, public-preview cleanup, browser quota errors, and hard deletion.
- [x] **Step 4: Fix** substantiated review findings and rerun the affected verification commands.
