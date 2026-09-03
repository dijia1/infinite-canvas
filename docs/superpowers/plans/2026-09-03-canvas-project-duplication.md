# Canvas Project Duplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user duplicate a canvas from its library card without copying the underlying media files.

**Architecture:** Keep the UI action in `CanvasProjectCard`, but put duplication ownership in the canvas Zustand store so ID creation, document cloning and existing save-queue behavior stay together. Extract the document-copy and title-allocation rules into a pure helper, which future template or bulk-copy actions can reuse.

**Tech Stack:** Next.js client components, Zustand, TypeScript, Node test runner, Lucide icons.

**Spec:** User-approved canvas-library copy design from the 2026-09-03 review in this conversation.

## Global Constraints

- A duplicate receives a fresh project ID, timestamps and server revision, then uses the existing create/save queue.
- Nodes, connections, mask resources and viewport are copied without shared mutable references.
- Node IDs and media identifiers remain unchanged because their scope is the copied project and they preserve internal graph references.
- No binary media blob is copied, uploaded or deleted as part of duplication.
- The copied project remains in the library; the user is not navigated into it.

---

### Task 1: Create a reusable project-copy snapshot helper

**Files:**
- Create: `web/src/app/(user)/canvas/utils/canvas-project-copy.ts`
- Test: `web/src/app/(user)/canvas/utils/canvas-project-copy.test.ts`

**Interfaces:**
- Produces: `createCanvasProjectCopy(source, options): CanvasProject`
- Produces: `nextCanvasProjectCopyTitle(title, existingTitles): string`
- Consumed by: `use-canvas-store.ts`

- [x] **Step 1: Write the failing tests**

```ts
test("creates a document-independent canvas copy", () => {
    const copy = createCanvasProjectCopy(source, { id: "copy", title: "源画布 副本", now: "2026-09-03T00:00:00.000Z" });
    assert.equal(copy.id, "copy");
    assert.deepEqual(copy.nodes, source.nodes);
    assert.notEqual(copy.nodes, source.nodes);
    assert.notEqual(copy.nodes[0]?.metadata, source.nodes[0]?.metadata);
});

test("allocates an unused copy title", () => {
    assert.equal(nextCanvasProjectCopyTitle("源画布", ["源画布", "源画布 副本"]), "源画布 副本 2");
});
```

- [x] **Step 2: Run the helper test and verify it fails because the module is missing**

Run: `bun test './src/app/(user)/canvas/utils/canvas-project-copy.test.ts'`

- [x] **Step 3: Implement the pure copy helper**

```ts
export function createCanvasProjectCopy(source: CanvasProject, options: CanvasProjectCopyOptions): CanvasProject {
    return {
        ...structuredClone(source),
        id: options.id,
        title: options.title,
        createdAt: options.now,
        updatedAt: options.now,
    };
}
```

Use `nextCanvasProjectCopyTitle` to choose `“{title} 副本”`, then numbered suffixes when needed.

- [x] **Step 4: Run the helper test and verify it passes**

Run: `bun test './src/app/(user)/canvas/utils/canvas-project-copy.test.ts'`

### Task 2: Add a store-owned duplication action

**Files:**
- Modify: `web/src/app/(user)/canvas/stores/use-canvas-store.ts`
- Modify: `web/src/app/(user)/canvas/stores/use-canvas-store.test.ts`

**Interfaces:**
- Consumes: `createCanvasProjectCopy`, `nextCanvasProjectCopyTitle`
- Produces: `duplicateProject(id: string): string | null`
- Consumed by: `CanvasProjectCard`

- [x] **Step 1: Write a failing store test**

```ts
test("duplicates a project as a new server-created project", async () => {
    const id = store.getState().duplicateProject("project-1");
    assert.ok(id);
    assert.notEqual(id, "project-1");
    assert.equal(store.getState().openProject(id!)?.title, "服务器画布 副本");
    await waitForDebounce();
    assert.equal(created[0]?.id, id);
});
```

- [x] **Step 2: Run the store test and verify it fails because `duplicateProject` is missing**

Run: `bun test './src/app/(user)/canvas/stores/use-canvas-store.test.ts'`

- [x] **Step 3: Add the minimal store action**

```ts
duplicateProject: (sourceId) => {
    const source = get().projects.find((project) => project.id === sourceId);
    if (!source) return null;
    const id = nanoid();
    const project = createCanvasProjectCopy(source, {
        id,
        title: nextCanvasProjectCopyTitle(source.title, get().projects.map((item) => item.title)),
        now: new Date().toISOString(),
    });
    set((state) => ({ projects: [project, ...state.projects] }));
    queueChange(id);
    return id;
},
```

- [x] **Step 4: Run the store test and verify it passes**

Run: `bun test './src/app/(user)/canvas/stores/use-canvas-store.test.ts'`

### Task 3: Add the library-card copy action

**Files:**
- Modify: `web/src/app/(user)/canvas/components/canvas-project-card.tsx`

**Interfaces:**
- Consumes: `duplicateProject(project.id): string | null`
- Produces: A `Copy` icon button positioned immediately before `Download`

- [x] **Step 1: Add the card action**

```tsx
<Button
    type="text"
    size="small"
    shape="circle"
    icon={<Copy className="size-4" />}
    onClick={duplicate}
    aria-label="复制画布"
/>
<Button icon={<Download className="size-4" />} ... />
```

The click must stop card propagation through the existing action wrapper, leave the user in the library, and show a success message only after a new ID was returned.

- [x] **Step 2: Run focused verification**

Run: `bun run typecheck && bun test './src/app/(user)/canvas/utils/canvas-project-copy.test.ts' './src/app/(user)/canvas/stores/use-canvas-store.test.ts'`

### Task 4: Verify integration and scope

**Files:**
- Verify: `web/src/app/(user)/canvas/components/canvas-project-card.tsx`
- Verify: `web/src/app/(user)/canvas/stores/use-canvas-store.ts`

- [x] **Step 1: Run the frontend production build**

Run: `bun run build`

- [x] **Step 2: Inspect the working-tree diff**

Run: `git diff --check && git diff --stat`

- [ ] **Step 3: Manually verify in the local canvas library**

Click the copy icon, confirm a new `“副本”` card appears without navigation, then open it and verify nodes, connections and images are present.
