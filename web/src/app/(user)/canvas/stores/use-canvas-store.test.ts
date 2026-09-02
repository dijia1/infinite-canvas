import assert from "node:assert/strict";
import test from "node:test";

import { ApiRequestError } from "@/services/api/request";
import type { CanvasProjectRecord, CanvasProjectsApi } from "@/services/api/canvas-projects";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import { createCanvasStore, type CanvasStore } from "./use-canvas-store.ts";

const waitForDebounce = () => new Promise((resolve) => setTimeout(resolve, 35));

function serverProject(overrides: Partial<CanvasProjectRecord> = {}): CanvasProjectRecord {
    return {
        id: "project-1",
        title: "服务器画布",
        revision: 1,
        createdAt: "2026-09-02T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        document: {
            nodes: [],
            connections: [],
            backgroundMode: "lines",
            showImageInfo: false,
            viewport: { x: 0, y: 0, k: 1 },
        },
        ...overrides,
    };
}

function apiDouble(overrides: Partial<CanvasProjectsApi> = {}) {
    const saved: CanvasProjectRecord[] = [];
    const api: CanvasProjectsApi = {
        list: async () => ({ items: [], total: 0 }),
        get: async () => serverProject(),
        create: async (input) => serverProject({ ...input, revision: 1 }),
        importProjects: async () => ({ items: [], total: 0 }),
        update: async (id, input) => {
            const result = serverProject({ id, title: input.title, document: input.document, revision: input.revision + 1 });
            saved.push(result);
            return result;
        },
        delete: async () => undefined,
        ...overrides,
    };
    return { api, saved };
}

test("coalesces rapid local edits into one latest server save", async () => {
    const { api, saved } = apiDouble();
    const store = createCanvasStore({ api, serverDebounceMs: 10, isOnline: () => true });
    store.getState().replaceProjectsFromServer([serverProject()]);
    store.getState().startSync("portal-user");

    store.getState().renameProject("project-1", "第一次");
    store.getState().renameProject("project-1", "最终标题");
    await waitForDebounce();

    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.title, "最终标题");
    assert.deepEqual(store.getState().projectSync["project-1"], {
        serverRevision: 2,
        dirty: false,
        pending: false,
        saving: false,
        offline: false,
        error: null,
        conflict: false,
        operation: "save",
    });
});

test("keeps offline edits pending and saves them after connectivity returns", async () => {
    let online = false;
    const { api, saved } = apiDouble();
    const store = createCanvasStore({ api, serverDebounceMs: 10, isOnline: () => online });
    store.getState().replaceProjectsFromServer([serverProject()]);
    store.getState().startSync("portal-user");

    store.getState().renameProject("project-1", "离线修改");
    await waitForDebounce();

    assert.equal(saved.length, 0);
    assert.equal(store.getState().projectSync["project-1"]?.offline, true);
    assert.equal(store.getState().projectSync["project-1"]?.pending, true);

    online = true;
    store.getState().retryPendingSaves();
    await waitForDebounce();

    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.title, "离线修改");
    assert.equal(store.getState().projectSync["project-1"]?.serverRevision, 2);
    assert.equal(store.getState().projectSync["project-1"]?.pending, false);
});

test("stops retrying a revision conflict until the user refreshes the server copy", async () => {
    let updateCount = 0;
    let getCount = 0;
    const serverCopy = serverProject({
        title: "服务器新版本",
        revision: 2,
        document: {
            ...serverProject().document,
            nodes: [
                {
                    id: "server-image",
                    type: "image" as never,
                    title: "图片",
                    position: { x: 1, y: 2 },
                    width: 100,
                    height: 100,
                    metadata: { mediaId: "media-1", publicImageId: "public-1" },
                },
            ],
        },
    });
    const { api } = apiDouble({
        update: async () => {
            updateCount += 1;
            throw new ApiRequestError("版本冲突", 409, 1);
        },
        get: async () => {
            getCount += 1;
            return serverCopy;
        },
    });
    const store = createCanvasStore({ api, serverDebounceMs: 10, isOnline: () => true });
    store.getState().replaceProjectsFromServer([serverProject()]);
    store.getState().startSync("portal-user");

    store.getState().renameProject("project-1", "本地冲突版本");
    await waitForDebounce();

    assert.equal(updateCount, 1);
    assert.equal(getCount, 0);
    assert.equal(store.getState().openProject("project-1")?.title, "本地冲突版本");
    assert.equal(store.getState().projectSync["project-1"]?.conflict, true);

    store.getState().retryPendingSaves();
    await waitForDebounce();
    assert.equal(updateCount, 1);

    await store.getState().refreshProjectFromServer("project-1");
    assert.equal(getCount, 1);
    assert.equal(store.getState().openProject("project-1")?.title, "服务器新版本");
    assert.equal(store.getState().openProject("project-1")?.nodes[0]?.metadata?.mediaId, "media-1");
    assert.equal(store.getState().projectSync["project-1"]?.serverRevision, 2);
    assert.equal(store.getState().projectSync["project-1"]?.conflict, false);
});

test("guest mode remains local and never starts server synchronization", async () => {
    let requestCount = 0;
    const { api } = apiDouble({
        create: async () => {
            requestCount += 1;
            return serverProject();
        },
        update: async () => {
            requestCount += 1;
            return serverProject();
        },
    });
    const store = createCanvasStore({ api, serverDebounceMs: 10, isOnline: () => true });
    store.getState().startSync("guest");

    const id = store.getState().createProject("访客画布");
    store.getState().renameProject(id, "只在本地");
    await waitForDebounce();

    assert.equal(requestCount, 0);
    assert.equal(store.getState().openProject(id)?.title, "只在本地");
    assert.equal(store.getState().projectSync[id], undefined);
});

test("persists local projects and sync metadata before the server debounce", () => {
    const writes: StorageValue<unknown>[] = [];
    const storage: PersistStorage<CanvasStore> = {
        getItem: async () => null,
        setItem: async (_name, value) => {
            writes.push(value);
        },
        removeItem: async () => undefined,
    };
    const { api } = apiDouble();
    const store = createCanvasStore({ api, storage, serverDebounceMs: 10_000, isOnline: () => true });
    store.getState().replaceProjectsFromServer([serverProject()]);
    store.getState().startSync("portal-user");

    store.getState().renameProject("project-1", "立即落本地");

    const persisted = writes.at(-1)?.state as { projects: Array<{ title: string; projectSync?: unknown }>; projectSync: Record<string, { pending: boolean }> };
    assert.equal(persisted.projects[0]?.title, "立即落本地");
    assert.equal(persisted.projects[0]?.projectSync, undefined);
    assert.equal(persisted.projectSync["project-1"]?.pending, true);
});

test("serializes writes for one project while preserving edits made during a save", async () => {
    const firstSave = Promise.withResolvers<void>();
    const savedTitles: string[] = [];
    let active = 0;
    let maxActive = 0;
    const { api } = apiDouble({
        update: async (id, input) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            savedTitles.push(input.title);
            if (savedTitles.length === 1) await firstSave.promise;
            active -= 1;
            return serverProject({ id, title: input.title, document: input.document, revision: input.revision + 1 });
        },
    });
    const store = createCanvasStore({ api, serverDebounceMs: 10, isOnline: () => true });
    store.getState().replaceProjectsFromServer([serverProject()]);
    store.getState().startSync("portal-user");

    store.getState().renameProject("project-1", "保存中版本");
    await waitForDebounce();
    store.getState().renameProject("project-1", "保存期间的新版本");
    await waitForDebounce();
    assert.equal(maxActive, 1);

    firstSave.resolve();
    await waitForDebounce();

    assert.deepEqual(savedTitles, ["保存中版本", "保存期间的新版本"]);
    assert.equal(maxActive, 1);
    assert.equal(store.getState().projectSync["project-1"]?.serverRevision, 3);
    assert.equal(store.getState().projectSync["project-1"]?.pending, false);
});
