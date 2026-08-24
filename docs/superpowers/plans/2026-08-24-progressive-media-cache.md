# Progressive Media Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent startup-time media downloads and bound browser image-cache disk and memory use while preserving offline recovery.

**Architecture:** Persist only metadata at startup. Image cards request a WebP preview when they become visible; canvas images request originals only when their world-space bounds enter the active viewport. IndexedDB stores blobs separately from a metadata-only LRU index, so budget eviction never reads image bytes.

**Tech Stack:** Next.js, React 19, TypeScript, Zustand, localForage/IndexedDB, native `IntersectionObserver`, `navigator.storage.estimate()`.

**Spec:** User-approved progressive cache proposal from 2026-08-24.

## Global Constraints

- Portal-user cache partitions remain isolated.
- Browser cache is non-authoritative; OSS and media records remain the source of truth.
- Disk cache target is 2 GiB; eviction starts at 1.8 GiB and ends at 1.4 GiB.
- Pending uploads, in-flight media, visible media, and active edit references cannot be evicted.
- Do not perform a startup scan that reads legacy Blob values.

---

### Task 1: Add metadata-only cache accounting

**Files:**
- Modify: `web/src/services/image-storage.ts`
- Test: `web/src/services/image-storage-cache.test.ts`

- [ ] Add failing tests for LRU eviction and cache high/low watermarks.
- [ ] Add an IndexedDB metadata index for bytes, variant, and `lastAccessedAt`.
- [ ] Update writes, reads, promotion, and deletion to keep blob and metadata records consistent.
- [ ] Evict previews before inactive originals; never evict protected or in-flight entries.

### Task 2: Remove startup original-image recovery

**Files:**
- Modify: `web/src/stores/use-asset-store.ts`
- Modify: `web/src/stores/asset-storage-hydration.ts`
- Test: `web/src/stores/asset-storage-hydration.test.ts`

- [ ] Add failing tests showing persisted remote assets stay metadata-only during hydrate.
- [ ] Preserve recovery only for pending local uploads.
- [ ] Remove startup calls that resolve or download remote original images.

### Task 3: Lazy-load material previews

**Files:**
- Create: `web/src/app/(user)/canvas/components/use-visible-media-preview.ts`
- Modify: `web/src/app/(user)/canvas/components/asset-picker-modal.tsx`
- Modify: `web/src/app/(user)/canvas/components/public-image-drawer.tsx`
- Test: `web/src/app/(user)/canvas/components/use-visible-media-preview.test.ts`

- [ ] Add failing tests for visibility-gated loading and object-URL release.
- [ ] Use `IntersectionObserver` with a 400px prefetch margin.
- [ ] Load at most four previews concurrently and release object URLs after unmount.

### Task 4: Restore canvas media by viewport

**Files:**
- Modify: `web/src/services/canvas-image-hydration.ts`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`
- Test: `web/src/services/canvas-image-hydration.test.ts`

- [ ] Add failing tests that offscreen nodes retain metadata and do not fetch originals.
- [ ] Hydrate cached and remote originals for visible plus padded world-space bounds only.
- [ ] Queue later viewport entries without blocking project load.

### Task 5: Verify and regress

**Files:**
- Modify: relevant tests only

- [ ] Run targeted tests after each task.
- [ ] Run `bun test`, `bun run typecheck`, and `bun run build`.
- [ ] Inspect the final diff for unrelated changes.
