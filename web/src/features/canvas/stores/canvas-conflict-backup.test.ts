import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasStorage, createCanvasStore } from "./use-canvas-store";
import { memoryCanvasDisk } from "@/test-utils/canvas-document-storage";
import type { CanvasProjectDetail } from "@/services/api/canvas-projects";
import { CanvasNodeType } from "../types";

const remote: CanvasProjectDetail = { id: "a", title: "server", revision: 2, createdAt: "2026-10-01", updatedAt: "2026-10-01", document: { nodes: [], connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } } };
async function setup(disk: ReturnType<typeof memoryCanvasDisk>["disk"]) {
    const store = createCanvasStore({
        storage: createCanvasStorage(disk),
        isOnline: () => false,
        api: {
            list: async () => ({ items: [], total: 0 }),
            get: async () => remote,
            create: async (input) => ({ ...remote, ...input, revision: 1 }),
            update: async () => remote,
            delete: async () => {},
            importProjects: async () => ({ items: [], total: 0 }),
        },
    });
    await store.getState().hydrate("owner");
    store.getState().replaceProjectsFromServer([{ ...remote, title: "draft", revision: 1 }]);
    store.getState().startSync("owner");
    store.setState((s) => ({ projectSync: { ...s.projectSync, a: { ...s.projectSync.a, conflict: true, dirty: true } } }));
    await store.getState().waitForLocalPersistence();
    return store;
}

test("server reload waits for the conflict copy to become durable, including pending editor uploads", async () => {
    const { disk } = memoryCanvasDisk(),
        entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
    const commit = disk.compareAndSetItems;
    disk.compareAndSetItems = async (entries, expected) => {
        if (entries.some(([, raw]) => raw.includes("冲突副本"))) {
            entered.resolve();
            await release.promise;
        }
        return commit(entries, expected);
    };
    const store = await setup(disk);
    const image = { id: "pending", type: CanvasNodeType.Image, title: "pending", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "image:local", localUploadState: "failed" as const, content: "blob:preview" } };
    const unregister = store.getState().registerProjectDraftReader("a", () => ({ nodes: [image], viewport: { x: 50, y: 0, k: 0.3 } }));
    const refreshing = store.getState().refreshProjectFromServer("a");
    await entered.promise;
    assert.equal(store.getState().openProject("a")?.title, "draft", "original replaced before backup commit");
    release.resolve();
    await refreshing;
    const recovered = (await createCanvasStorage(disk).getItem("infinite-canvas:canvas_store:owner"))!.state;
    const copy = recovered.projects.find((p) => p.id !== "a")!;
    assert.ok(copy);
    assert.equal(copy.nodes[0].metadata?.storageKey, "image:local");
    assert.equal(copy.viewport.x, 50);
    assert.equal(recovered.projectSync[copy.id].serverRevision, null);
    assert.equal(store.getState().openProject("a")?.title, "server");
    unregister();
    store.getState().releaseProjectEditor(copy.id);
});

test("backup storage failure stops server replacement and leaves the original local draft", async () => {
    const { disk } = memoryCanvasDisk();
    const commit = disk.compareAndSetItems;
    const store = await setup(disk);
    disk.compareAndSetItems = async (entries, expected) => {
        if (entries.some(([, raw]) => raw.includes("冲突副本"))) throw new Error("disk full");
        return commit(entries, expected);
    };
    await assert.rejects(store.getState().refreshProjectFromServer("a"), /disk full/);
    assert.equal(store.getState().openProject("a")?.title, "draft");
    assert.equal(store.getState().projectSync.a.conflict, true);
    assert.match(store.getState().projectSync.a.error!, /disk full/);
});

test("a backup after ownership loss writes a new canvas and cannot overwrite a newer owner's original", async () => {
    const { disk } = memoryCanvasDisk();
    const old = await setup(disk);
    const source = structuredClone(old.getState().openProject("a")!);
    old.getState().setProjectSyncBlocked("a", true);
    const name = "infinite-canvas:canvas_store:owner",
        newer = createCanvasStorage(disk),
        state = (await newer.getItem(name))!;
    await newer.setItem(name, { ...state, state: { ...state.state, projects: state.state.projects.map((p) => (p.id === "a" ? { ...p, title: "new owner" } : p)) } });
    const id = await old.getState().preserveProjectDraft("a", source);
    assert.ok(id);
    const restored = (await createCanvasStorage(disk).getItem(name))!.state;
    assert.equal(restored.projects.find((p) => p.id === "a")?.title, "new owner");
    assert.equal(restored.projects.find((p) => p.id === id)?.title, "draft（冲突副本）");
});

test("deleting a previous conflict copy does not make the next replacement skip its backup", async () => {
    const { disk } = memoryCanvasDisk();
    const store = await setup(disk);
    const source = structuredClone(store.getState().openProject("a")!);
    const first = await store.getState().preserveProjectDraft("a", source);
    store.getState().deleteProjects([first!]);
    await store.getState().waitForLocalPersistence();
    const next = await store.getState().preserveProjectDraft("a", source);
    assert.ok(next);
    assert.notEqual(next, first);
    assert.ok(store.getState().openProject(next!));
});

test("a conflict copy deleted by another tab must be backed up again before replacement", async () => {
    const { disk } = memoryCanvasDisk();
    const store = await setup(disk);
    const source = structuredClone(store.getState().openProject("a")!);
    const first = await store.getState().preserveProjectDraft("a", source);
    const name = "infinite-canvas:canvas_store:owner",
        other = createCanvasStorage(disk),
        saved = (await other.getItem(name))!;
    await other.setItem(name, { ...saved, state: { ...saved.state, projects: saved.state.projects.filter((p) => p.id !== first), projectSync: Object.fromEntries(Object.entries(saved.state.projectSync).filter(([id]) => id !== first)) } });
    const next = await store.getState().preserveProjectDraft("a", source);
    assert.ok(next);
    assert.notEqual(next, first);
    const restored = (await createCanvasStorage(disk).getItem(name))!.state;
    assert.ok(restored.projects.some((p) => p.id === next && p.title === "draft（冲突副本）"));
});
