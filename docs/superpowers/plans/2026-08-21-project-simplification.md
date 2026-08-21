# Project Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove confirmed obsolete material and local-login code, consolidate material-drawer UI, and remove unused direct dependencies without changing Portal SSO, OSS media behavior, or canvas data.

**Architecture:** Browser-scoped private assets and OSS-backed public images are the active product path. The previous server `Asset` model and associated list/edit APIs are unused and should be removed end-to-end. The two material drawers retain distinct data and permission behavior, but share their shell and editable-target predicate.

**Tech Stack:** Go 1.25, Gin, GORM, Next.js 16, React 19, TypeScript, Ant Design, Zustand, Bun.

**Spec:** 2026-08-21 user request, based on the `project-simplification` audit in this task.

## Global Constraints

- Preserve Portal identity, `portal-admin` checks, OSS media object paths, signed URLs, IndexedDB scopes, and `/api/v1/public-images` / `/api/v1/media/*` behavior.
- Remove `/api/assets` and `/api/admin/assets` only as one coherent breaking API change; do not migrate or delete existing database rows.
- Do not add dependencies, a global store, or a generic uploader abstraction.
- Keep private/public material data flows distinct. Do not split `canvas-client-page.tsx` in this plan.

---

### Task 1: Remove the obsolete server-material implementation

**Files:**

- Delete: `model/asset.go`, `repository/asset.go`, `service/assets.go`, `handler/assets.go`
- Delete: `web/src/services/api/assets.ts`, `web/src/app/(admin)/admin/assets/use-admin-assets.ts`
- Modify: `router/router.go`, `repository/db.go`, `web/src/services/api/admin.ts`, `docs/features.md`, `docs/backend-database.md`
- Create: `router/router_test.go`

**Interfaces:** Removes only `GET /api/assets`, `GET|POST /api/admin/assets`, and `DELETE /api/admin/assets/:id`. The `/admin/assets` page stays: it renders the public-image manager.

- [ ] **Step 1: Write a failing route-contract test**

Create `router/router_test.go`:

```go
package router

import "testing"

func TestLegacyAssetRoutesAreNotRegistered(t *testing.T) {
	legacy := map[string]bool{
		"/api/assets": true,
		"/api/admin/assets": true,
		"/api/admin/assets/:id": true,
	}
	for _, route := range New().Routes() {
		if legacy[route.Path] {
			t.Fatalf("legacy asset route is still registered: %s %s", route.Method, route.Path)
		}
	}
}
```

- [ ] **Step 2: Verify the test fails**

Run `go test ./router -run TestLegacyAssetRoutesAreNotRegistered -count=1`.

Expected: it names one or more registered legacy asset routes.

- [ ] **Step 3: Delete the old backend stack**

Delete the four Go implementation files, remove `&model.Asset{}` from `repository/db.go`, and remove the four routes from `router/router.go`. Keep all media and public-image routes unchanged.

- [ ] **Step 4: Delete the old front-end API stack**

Delete the two front-end modules. In `web/src/services/api/admin.ts`, remove `AdminAsset`, `AdminAssetListResponse`, `AdminAssetQuery`, `fetchAdminAssets`, `saveAdminAsset`, `deleteAdminAsset`, and their now-unused request helper imports.

- [ ] **Step 5: Correct documentation**

Replace old server-material descriptions with these statements in both documentation files:

```markdown
- 我的素材保存在当前 Portal 用户浏览器的本地存储中。
- 公共素材只保存图片，由 portal-admin 上传到媒体存储后供 Portal 用户读取。
- 旧的服务器通用素材（文本、图片、视频）API 与 Asset 表管理功能不再提供。
```

- [ ] **Step 6: Verify and commit**

Run:

```bash
go test ./router ./repository ./service -count=1
cd web && bunx tsc --noEmit
```

Then commit:

```bash
git add router repository model service handler web/src/services/api web/src/app/(admin)/admin/assets docs
git commit -m "refactor: remove legacy asset library"
```

### Task 2: Remove local-login compatibility residue

**Files:**

- Modify: `web/src/services/api/admin.ts`, `web/src/stores/use-admin-store.ts`
- Create: `web/src/stores/use-admin-store.test.ts`

**Interfaces:** Preserves `hydrateAdmin`, `clearSession`, `token`, `user`, and `isReady`. Removes `AdminSession`, `loginAdmin`, and the unused `login` store method.

- [ ] **Step 1: Write a failing source-contract test**

Create `web/src/stores/use-admin-store.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("admin authentication only uses the Portal session", async () => {
    const [api, store] = await Promise.all([
        readFile(new URL("../services/api/admin.ts", import.meta.url), "utf8"),
        readFile(new URL("./use-admin-store.ts", import.meta.url), "utf8"),
    ]);
    assert.doesNotMatch(api, /\/api\/admin\/login/);
    assert.doesNotMatch(store, /login:\s*async/);
    assert.match(store, /fetchCurrentAdmin\(""\)/);
});
```

- [ ] **Step 2: Verify the test fails**

Run `cd web && bun test src/stores/use-admin-store.test.ts`.

Expected: it finds `/api/admin/login` and `login: async`.

- [ ] **Step 3: Delete dead local-login code**

Remove `AdminSession` and `loginAdmin` from `admin.ts`. Remove the `login` type member and throwing implementation from `use-admin-store.ts`. Do not rename the persisted store key or remove the informational `/admin/login` page.

- [ ] **Step 4: Verify and commit**

Run:

```bash
cd web && bun test src/stores/use-admin-store.test.ts && bunx tsc --noEmit
```

Then commit:

```bash
git add web/src/services/api/admin.ts web/src/stores/use-admin-store.ts web/src/stores/use-admin-store.test.ts
git commit -m "refactor: remove local admin login residue"
```

### Task 3: Consolidate material-drawer presentation helpers

**Files:**

- Create: `web/src/app/(user)/canvas/components/material-drawer.tsx`, `web/src/lib/editable-target.ts`
- Modify: `asset-picker-modal.tsx`, `public-image-drawer.tsx`, `public-image-manager.tsx`, `material-drawers.test.ts`

**Interfaces:** `MaterialDrawer` receives `title`, `closeLabel`, `onClose`, `onPointerEnter`, `onPointerLeave`, and `children`. `isEditableTarget(target: EventTarget | null): boolean` returns true for inputs, textareas, and contenteditable nodes.

- [ ] **Step 1: Extend the existing test first**

Append to `material-drawers.test.ts`:

```ts
test("material drawers reuse the shared shell and editable target helper", async () => {
    const [privateDrawer, publicDrawer, adminManager] = await Promise.all([
        readFile(componentURL("asset-picker-modal.tsx"), "utf8"),
        readFile(componentURL("public-image-drawer.tsx"), "utf8"),
        readFile(componentURL("../../../../app/(admin)/admin/assets/public-image-manager.tsx"), "utf8"),
    ]);
    assert.match(privateDrawer, /from "\.\/material-drawer"/);
    assert.match(publicDrawer, /from "\.\/material-drawer"/);
    assert.match(privateDrawer, /from "@\/lib\/editable-target"/);
    assert.match(publicDrawer, /from "@\/lib\/editable-target"/);
    assert.match(adminManager, /from "@\/lib\/editable-target"/);
});
```

- [ ] **Step 2: Verify the test fails**

Run `cd web && bun test 'src/app/(user)/canvas/components/material-drawers.test.ts'`.

Expected: the shared shell/helper imports are absent.

- [ ] **Step 3: Extract only identical UI and predicate code**

Create `material-drawer.tsx` by moving the shared fixed `aside`, header, title, and close button from the two drawers. Create `editable-target.ts` with:

```ts
export function isEditableTarget(target: EventTarget | null) {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}
```

Replace the three local `isEditableTarget` declarations with that import. Keep each drawer's query, upload mutation, paste listener, file input, card UI, and pagination local.

- [ ] **Step 4: Verify and commit**

Run:

```bash
cd web && bun test 'src/app/(user)/canvas/components/material-drawers.test.ts' && bunx tsc --noEmit
```

Then commit:

```bash
git add web/src/app/(user)/canvas/components/material-drawer.tsx web/src/app/(user)/canvas/components/asset-picker-modal.tsx web/src/app/(user)/canvas/components/public-image-drawer.tsx web/src/app/(admin)/admin/assets/public-image-manager.tsx web/src/lib/editable-target.ts web/src/app/(user)/canvas/components/material-drawers.test.ts
git commit -m "refactor: share material drawer primitives"
```

### Task 4: Remove unused UI modules and direct dependencies

**Files:**

- Delete: `web/src/components/ui/dia-text-reveal.tsx`, `web/src/components/ui/select.tsx`
- Modify: `web/package.json`, `web/bun.lock`
- Create: `web/src/components/ui/unused-ui-modules.test.ts`

**Interfaces:** Removes only direct dependencies `motion`, `radix-ui`, `class-variance-authority`, `@codemirror/lang-json`, `@uiw/react-codemirror`, and `dayjs`. Keeps `shadcn`, `tw-animate-css`, `tailwind-merge`, and `clsx`, which source or CSS imports still require.

- [ ] **Step 1: Write a failing manifest test**

Create `web/src/components/ui/unused-ui-modules.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package manifest omits removed UI dependencies", async () => {
    const manifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    for (const dependency of ["motion", "radix-ui", "class-variance-authority", "@codemirror/lang-json", "@uiw/react-codemirror", "dayjs"]) {
        assert.equal(manifest.dependencies[dependency], undefined, `${dependency} should not be direct`);
    }
});
```

- [ ] **Step 2: Verify the test fails**

Run `cd web && bun test src/components/ui/unused-ui-modules.test.ts`.

Expected: it reports the six currently declared dependencies.

- [ ] **Step 3: Remove modules and update Bun dependencies**

Delete the two unreferenced components, then from `web/` run:

```bash
bun remove motion radix-ui class-variance-authority @codemirror/lang-json @uiw/react-codemirror dayjs
```

Do not edit `package-lock.json` or `pnpm-lock.yaml`: Docker builds with Bun and `bun.lock`; historical lockfile policy is separate work.

- [ ] **Step 4: Verify and commit**

Run:

```bash
cd web && bun test src/components/ui/unused-ui-modules.test.ts && bunx tsc --noEmit && bun run build
```

Then commit:

```bash
git add web/package.json web/bun.lock web/src/components/ui
git commit -m "chore: remove unused frontend dependencies"
```

## Deliberately Deferred

`web/src/app/(user)/canvas/[id]/canvas-client-page.tsx` remains unchanged. A separate plan must first add behavioral coverage for undo/redo, pointer/selection/connection gestures, material drops and recovery, and image/video generation retries. Only then should it extract pure connection geometry or a media-drop/recovery unit; it must not be split merely to reduce line count.

## Plan Review

- Tasks 1–2 cover confirmed obsolete APIs and local-login remnants.
- Task 3 covers the three confirmed duplicate editable-target implementations and the two drawer shells without merging different business behavior.
- Task 4 covers confirmed unreferenced components and direct dependencies.
- Portal SSO, OSS, media authorization, user-scoped local storage, public-image endpoints, and the high-risk canvas client are explicitly preserved.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-21-project-simplification.md`.

Two execution options:

1. Subagent-Driven (recommended) — dispatch a fresh subagent per task and review between tasks.
2. Inline Execution — execute tasks in this session with review checkpoints.
