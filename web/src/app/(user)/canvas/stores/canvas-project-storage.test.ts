import assert from "node:assert/strict";
import test from "node:test";
import type { StorageValue } from "zustand/middleware";
import { createCanvasStorage, createCanvasStore, type CanvasStore, type CanvasProjectSync } from "./use-canvas-store";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const project = (id: string, title = id) => ({ id, title, createdAt: "2026-10-01", updatedAt: "2026-10-01", nodes: [], connections: [], maskResources: {}, backgroundMode: "lines" as const, showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } });
const clean = (): CanvasProjectSync => ({ serverRevision: 1, dirty: false, pending: false, saving: false, offline: false, error: null, conflict: false, operation: "save" });
const value = (projects = [project("a"), project("b")], projectSync = { a: clean(), b: clean() }) => ({ state: { projects, projectSync, summaries: [] } }) as unknown as StorageValue<CanvasStore>;
import { memoryCanvasDisk } from "@/test-utils/canvas-document-storage";

test("stale readonly state and catalog changes cannot erase another tab's draft or request", async () => {
    const { disk } = memoryCanvasDisk();
    const seed = createCanvasStorage(disk);
    await seed.setItem("owner", value());
    const a = createCanvasStorage(disk),
        b = createCanvasStorage(disk);
    const av = (await a.getItem("owner"))!,
        bv = (await b.getItem("owner"))!;
    const pending = {
        ...av.state.projectSync.a,
        dirty: true,
        pending: true,
        unknownRequest: {
            trace: { requestId: "request", tabId: "a", requestSeq: 1, reason: "autosave" as const },
            baseRevision: 1,
            title: "draft",
            document: { nodes: [], connections: [], backgroundMode: "lines" as const, showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } },
        },
    };
    await a.setItem("owner", { ...av, state: { ...av.state, projects: av.state.projects.map((p) => (p.id === "a" ? { ...p, title: "draft" } : p)), projectSync: { ...av.state.projectSync, a: pending } } } as StorageValue<CanvasStore>);
    await b.setItem("owner", { ...bv, state: { ...bv.state, blockedProjectSync: { a: true }, summaries: [] } });
    const restored = (await createCanvasStorage(disk).getItem("owner"))!.state;
    assert.equal(restored.projects.find((p) => p.id === "a")?.title, "draft");
    assert.equal(restored.projectSync.a.unknownRequest?.trace.requestId, "request");
    assert.equal(restored.projectSync.a.dirty, true);
});

test("different canvases commit independently; a stale writer is rejected atomically", async () => {
    const { disk } = memoryCanvasDisk();
    await createCanvasStorage(disk).setItem("owner", value());
    const a = createCanvasStorage(disk),
        b = createCanvasStorage(disk);
    const av = (await a.getItem("owner"))!,
        bv = (await b.getItem("owner"))!;
    const edit = (v: StorageValue<CanvasStore>, id: string) => ({
        ...v,
        state: { ...v.state, projects: v.state.projects.map((p) => (p.id === id ? { ...p, title: id + " draft" } : p)), projectSync: { ...v.state.projectSync, [id]: { ...v.state.projectSync[id], dirty: true } } },
    });
    await Promise.all([a.setItem("owner", edit(av, "a")), b.setItem("owner", edit(bv, "b"))]);
    await assert.rejects(async () => {
        await b.setItem("owner", edit(bv, "a"));
    }, /其他页面/);
    const restored = (await createCanvasStorage(disk).getItem("owner"))!.state;
    assert.deepEqual(restored.projects.map((p) => p.title).sort(), ["a draft", "b draft"]);
    assert.equal(restored.projectSync.a.dirty, true);
    assert.equal(restored.projectSync.b.dirty, true);
});

test("migration retains legacy data and recovers edits made by a rolled-back client as a separate copy", async () => {
    const { disk, values } = memoryCanvasDisk();
    await disk.setItem("owner:projects", JSON.stringify([project("a", "legacy draft")]));
    await disk.setItem("owner:sync", JSON.stringify({ a: { ...clean(), dirty: true } }));
    const storage = createCanvasStorage(disk),
        original = (await storage.getItem("owner"))!;
    assert.equal(original.state.projects[0].title, "legacy draft");
    assert.ok(values.has("owner:projects"));
    await storage.setItem("owner", { ...original, state: { ...original.state, projects: [{ ...original.state.projects[0], title: "new draft" }] } });
    await disk.setItem("owner:projects", JSON.stringify([project("a", "rollback edit")]));
    const recovered = (await createCanvasStorage(disk).getItem("owner"))!.state;
    assert.equal(recovered.projects.find((p) => p.id === "a")?.title, "new draft");
    assert.ok(recovered.projects.some((p) => p.title.includes("rollback edit") && p.id !== "a"));
    assert.equal((await createCanvasStorage(disk).getItem("owner"))!.state.projects.length, recovered.projects.length, "no duplicate recovery copies");
});

test("owner activation rereads the latest persisted canvas before server revalidation", async () => {
    const { disk } = memoryCanvasDisk();
    const name = "infinite-canvas:canvas_store:owner";
    await createCanvasStorage(disk).setItem(name, value());
    const api = {
        list: async () => ({ items: [], total: 0 }),
        get: async () => {
            throw new Error("must retain local draft");
        },
        create: async () => {
            throw new Error("offline");
        },
        importProjects: async () => ({ items: [], total: 0 }),
        update: async () => {
            throw new Error("offline");
        },
        delete: async () => {},
    };
    const b = createCanvasStore({ storage: createCanvasStorage(disk), api, isOnline: () => false });
    await b.getState().hydrate("owner");
    await flush();
    const a = createCanvasStorage(disk),
        av = (await a.getItem(name))!;
    await a.setItem(name, {
        ...av,
        state: { ...av.state, projects: av.state.projects.map((p) => (p.id === "a" ? { ...p, title: "latest offline draft" } : p)), projectSync: { ...av.state.projectSync, a: { ...av.state.projectSync.a, dirty: true, offline: true } } },
    });
    await b.getState().reloadProjectFromStorage("a");
    b.getState().startSync("owner");
    assert.equal((await b.getState().ensureProjectDetail("a", { revalidate: true })).title, "latest offline draft");
    b.getState().releaseProjectEditor("a");
});

test("migration retains pending delete and unknown-save metadata even without a live project", async () => {
    const { disk } = memoryCanvasDisk();
    const deletedProject = project("deleted", "pending deletion");
    await disk.setItem("owner:projects", "[]");
    const unknownRequest = {
        trace: { requestId: "31ccf75f-99da-4e93-b6f6-1bc63dd31953", tabId: "old-tab", requestSeq: 1, reason: "autosave" },
        baseRevision: 1,
        title: deletedProject.title,
        document: { nodes: [], connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } },
    };
    await disk.setItem("owner:sync", JSON.stringify({ deleted: { ...clean(), dirty: true, pending: true, operation: "delete", deletedProject, unknownRequest } }));
    const restored = (await createCanvasStorage(disk).getItem("owner"))!.state;
    assert.equal(restored.projects.length, 0);
    assert.equal(restored.projectSync.deleted.operation, "delete");
    assert.equal(restored.projectSync.deleted.deletedProject?.title, "pending deletion");
    assert.equal(restored.projectSync.deleted.unknownRequest?.trace.requestId, unknownRequest.trace.requestId);
});

test("catalog-only sync changes cannot block an independent canvas after another tab opens a detail", async () => {
    const { disk } = memoryCanvasDisk();
    await createCanvasStorage(disk).setItem("owner", value([project("b")]));
    const editor = createCanvasStorage(disk),
        library = createCanvasStorage(disk);
    const opened = (await editor.getItem("owner"))!,
        listed = (await library.getItem("owner"))!;
    await editor.setItem("owner", { ...opened, state: { ...opened.state, projects: [...opened.state.projects, project("a", "unconfirmed draft")], projectSync: { ...opened.state.projectSync, a: { ...clean(), dirty: true } } } });
    await library.setItem("owner", {
        ...listed,
        state: { ...listed.state, projects: listed.state.projects.map((p) => ({ ...p, title: "b draft" })), projectSync: { ...listed.state.projectSync, a: { ...clean(), serverRevision: 2 }, b: { ...clean(), dirty: true } } },
    });
    const restored = (await createCanvasStorage(disk).getItem("owner"))!.state;
    assert.equal(restored.projects.find((p) => p.id === "a")?.title, "unconfirmed draft");
    assert.equal(restored.projectSync.a.serverRevision, 1);
    assert.equal(restored.projects.find((p) => p.id === "b")?.title, "b draft");
});
