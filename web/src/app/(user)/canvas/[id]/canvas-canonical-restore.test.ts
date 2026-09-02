import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasStore } from "../stores/use-canvas-store.ts";
import type { CanvasProjectRecord, CanvasProjectsApi } from "@/services/api/canvas-projects";
import { createCanvasCanonicalRestore } from "./canvas-canonical-restore.ts";

function record(title: string, revision: number): CanvasProjectRecord {
    return { id: "project-1", title, revision, createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", document: { nodes: [], connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } } };
}

test("an open page applies the bootstrap canonical snapshot and cancels stale hydration", async () => {
    const store = createCanvasStore();
    const restore = createCanvasCanonicalRestore();
    const applied: string[] = [];
    let resolveLocal!: (value: string) => void;
    const localHydration = new Promise<string>((resolve) => (resolveLocal = resolve));

    const stale = restore.run({ projectId: "project-1", generation: 0 }, async () => localHydration, (title) => applied.push(title), () => ({ projectId: "project-1", generation: store.getState().canonicalGeneration }));
    store.getState().replaceProjectsFromServer([record("服务器画布", 2)]);
    const canonical = store.getState().openProject("project-1");
    await restore.run({ projectId: "project-1", generation: 1 }, async () => canonical?.title || "", (title) => applied.push(title), () => ({ projectId: "project-1", generation: store.getState().canonicalGeneration }));
    resolveLocal("过期本地画布");
    await stale;

    assert.deepEqual(applied, ["服务器画布"]);
    assert.equal(store.getState().canonicalGeneration, 1);
});

test("a mounted page ignores old lazy hydration after conflict refresh without triggering a save", async () => {
    const refreshed = record("冲突刷新版本", 2);
    const api: CanvasProjectsApi = {
        list: async () => ({ items: [], total: 0 }),
        get: async () => refreshed,
        create: async () => refreshed,
        importProjects: async () => ({ items: [], total: 0 }),
        update: async () => refreshed,
        delete: async () => undefined,
    };
    const store = createCanvasStore({ api });
    store.getState().replaceProjectsFromServer([record("旧服务器画布", 1)]);
    store.getState().startSync("portal-user");
    const restore = createCanvasCanonicalRestore();
    let renderedTitle = "";
    let saveCount = 0;
    const identity = () => ({ projectId: "project-1", generation: store.getState().canonicalGeneration });
    await restore.run(identity(), async () => "旧服务器画布", (title) => (renderedTitle = title), identity);

    let resolveLazy!: (title: string) => void;
    const lazyHydration = new Promise<string>((resolve) => (resolveLazy = resolve));
    const lazy = restore.runCurrent(identity(), async () => lazyHydration, (title) => {
        renderedTitle = title;
        saveCount += 1;
    }, identity);

    await store.getState().refreshProjectFromServer("project-1");
    await restore.run(identity(), async () => "冲突刷新版本", (title) => (renderedTitle = title), identity);
    resolveLazy("过期懒加载版本");
    await lazy;

    assert.equal(renderedTitle, "冲突刷新版本");
    assert.equal(saveCount, 0);
});
