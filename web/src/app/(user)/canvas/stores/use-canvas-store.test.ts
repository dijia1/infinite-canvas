import assert from "node:assert/strict";
import test from "node:test";

import { ApiRequestError } from "@/services/api/request";
import type { CanvasProjectRecord, CanvasProjectsApi } from "@/services/api/canvas-projects";
import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";
import { createCanvasStorage, createCanvasStore, type CanvasStore } from "./use-canvas-store.ts";

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

test("skips persistence and server sync when a canvas patch keeps every current reference", async () => {
    const { api, saved } = apiDouble();
    const store = createCanvasStore({ api, serverDebounceMs: 10, isOnline: () => true });
    store.getState().replaceProjectsFromServer([serverProject()]);
    store.getState().startSync("portal-user");
    const current = store.getState().openProject("project-1");
    assert.ok(current);

    store.getState().updateProject("project-1", {
        nodes: current.nodes,
        connections: current.connections,
        backgroundMode: current.backgroundMode,
        showImageInfo: current.showImageInfo,
        viewport: current.viewport,
    });
    await waitForDebounce();

    assert.equal(saved.length, 0);
    assert.equal(store.getState().projectSync["project-1"]?.dirty, false);
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
        get: async () => {
            requestCount += 1;
            return serverProject();
        },
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
    await store.getState().refreshProjectFromServer(id);
    await waitForDebounce();

    assert.equal(requestCount, 0);
    assert.equal(store.getState().openProject(id)?.title, "只在本地");
    assert.equal(store.getState().projectSync[id], undefined);
});

test("persists local projects and sync metadata before the server debounce", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const persisted = writes.at(-1)?.state as { projects: Array<{ title: string; projectSync?: unknown }>; projectSync: Record<string, { pending: boolean }> };
    assert.equal(persisted.projects[0]?.title, "立即落本地");
    assert.equal(persisted.projects[0]?.projectSync, undefined);
    assert.equal(persisted.projectSync["project-1"]?.pending, true);
});

test("does not reserialize project documents when only save metadata changes", async () => {
    const values = new Map<string, string>();
    const writes: string[] = [];
    const backingStorage: StateStorage = {
        getItem: async (name) => values.get(name) || null,
        setItem: async (name, value) => {
            writes.push(name);
            values.set(name, value);
        },
        removeItem: async (name) => {
            values.delete(name);
        },
    };
    const storage = createCanvasStorage(backingStorage);
    const projects = [
        {
            ...serverProject().document,
            id: "project-1",
            title: "本地画布",
            createdAt: "2026-09-02T00:00:00.000Z",
            updatedAt: "2026-09-02T00:00:00.000Z",
        },
    ];

    await storage.setItem("canvas", { state: { projects, projectSync: {} } } as unknown as StorageValue<CanvasStore>);
    await storage.setItem("canvas", { state: { projects, projectSync: { "project-1": { serverRevision: 1, dirty: true, pending: true, saving: false, offline: false, error: null, conflict: false, operation: "save" } } } } as unknown as StorageValue<CanvasStore>);

    assert.equal(writes.filter((name) => name === "canvas:projects").length, 1);
    assert.equal(writes.filter((name) => name === "canvas:sync").length, 2);
    const restored = await storage.getItem("canvas");
    assert.equal((restored?.state as CanvasStore).projects[0]?.title, "本地画布");
    assert.equal((restored?.state as CanvasStore).projectSync["project-1"]?.pending, true);
});

test("keeps a rehydrated dirty local project when server snapshots are merged", async () => {
    const local = serverProject({ title: "未同步的本地标题" });
    const localProject = { ...local.document, id: local.id, title: local.title, createdAt: local.createdAt, updatedAt: local.updatedAt };
    const localSync = {
        serverRevision: 1,
        dirty: true,
        pending: true,
        saving: false,
        offline: true,
        error: null,
        conflict: false,
        operation: "save" as const,
    };
    const storage: PersistStorage<CanvasStore> = {
        getItem: async () => ({ state: { projects: [localProject], projectSync: { [local.id]: localSync } } }) as never,
        setItem: async () => undefined,
        removeItem: async () => undefined,
    };
    const { api } = apiDouble();
    const store = createCanvasStore({ api, storage, serverDebounceMs: 10, isOnline: () => true });

    await store.getState().hydrate("portal-user");
    store.getState().replaceProjectsFromServer([serverProject({ title: "服务端较新标题", revision: 2 })]);

    assert.equal(store.getState().openProject(local.id)?.title, "未同步的本地标题");
    assert.deepEqual(store.getState().projectSync[local.id], localSync);
});

test("waits for the newest local persistence write before mutating the server", async () => {
    const persisted = Promise.withResolvers<void>();
    let saveCount = 0;
    const storage: PersistStorage<CanvasStore> = {
        getItem: async () => null,
        setItem: async (_name, value) => {
            const state = value.state as CanvasStore;
            if (state.projects[0]?.title === "等待落盘") await persisted.promise;
        },
        removeItem: async () => undefined,
    };
    const { api } = apiDouble({
        update: async (id, input) => {
            saveCount += 1;
            return serverProject({ id, title: input.title, document: input.document, revision: input.revision + 1 });
        },
    });
    const store = createCanvasStore({ api, storage, serverDebounceMs: 10, isOnline: () => true });
    store.getState().replaceProjectsFromServer([serverProject()]);
    store.getState().startSync("portal-user");

    store.getState().renameProject("project-1", "等待落盘");
    await waitForDebounce();
    assert.equal(saveCount, 0);

    persisted.resolve();
    await waitForDebounce();
    assert.equal(saveCount, 1);
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

test("serializes deletion after an in-flight save without saving the deleted project again", async () => {
    const firstSave = Promise.withResolvers<void>();
    const operations: string[] = [];
    const { api } = apiDouble({
        update: async (id, input) => {
            operations.push(`update:${input.revision}:${input.title}`);
            await firstSave.promise;
            return serverProject({ id, title: input.title, document: input.document, revision: input.revision + 1 });
        },
        delete: async (_id, revision) => {
            operations.push(`delete:${revision}`);
        },
    });
    const store = createCanvasStore({ api, serverDebounceMs: 10, isOnline: () => true });
    store.getState().replaceProjectsFromServer([serverProject()]);
    store.getState().startSync("portal-user");

    store.getState().renameProject("project-1", "保存后删除");
    await waitForDebounce();
    store.getState().deleteProjects(["project-1"]);
    await waitForDebounce();
    assert.deepEqual(operations, ["update:1:保存后删除"]);

    firstSave.resolve();
    await waitForDebounce();
    assert.deepEqual(operations, ["update:1:保存后删除", "delete:2"]);
    assert.equal(store.getState().openProject("project-1"), null);
    assert.equal(store.getState().projectSync["project-1"], undefined);
});

test("restores the local project when a stale delete conflicts", async () => {
    let deleteCount = 0;
    const local = serverProject({
        title: "本地待删除版本",
        document: {
            ...serverProject().document,
            nodes: [
                {
                    id: "local-node",
                    type: "text" as never,
                    title: "本地节点",
                    position: { x: 0, y: 0 },
                    width: 100,
                    height: 100,
                    metadata: { content: "本地内容" },
                },
            ],
        },
    });
    const { api } = apiDouble({
        delete: async () => {
            deleteCount += 1;
            throw new ApiRequestError("版本冲突", 409, 1);
        },
    });
    const store = createCanvasStore({ api, serverDebounceMs: 10, isOnline: () => true });
    store.getState().replaceProjectsFromServer([local]);
    store.getState().startSync("portal-user");

    store.getState().deleteProjects([local.id]);
    await waitForDebounce();

    assert.equal(deleteCount, 1);
    assert.equal(store.getState().openProject(local.id)?.title, "本地待删除版本");
    assert.equal(store.getState().openProject(local.id)?.nodes[0]?.metadata?.content, "本地内容");
    assert.equal(store.getState().projectSync[local.id]?.conflict, true);
    assert.equal(store.getState().projectSync[local.id]?.operation, "delete");
});

test("authenticated hydration blocks initial editing until bootstrap succeeds or falls back offline", async () => {
    const { api } = apiDouble();
    const store = createCanvasStore({ api, storage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }, isOnline: () => false });

    await store.getState().hydrate("portal-user");
    assert.equal(store.getState().bootstrapStatus, "loading");
    assert.equal(store.getState().readyForCanvasMutations, false);

    const id = store.getState().createProject("bootstrap 中的项目");
    assert.equal(store.getState().projectSync[id]?.dirty, true);
    assert.equal(store.getState().projectSync[id]?.serverRevision, null);

    store.getState().markBootstrapUnavailable("portal-user");
    assert.equal(store.getState().bootstrapStatus, "offline");
    assert.equal(store.getState().readyForCanvasMutations, true);
});

test("keeps an authenticated online bootstrap failure distinct and exposes a retry", async () => {
    let retryCount = 0;
    const retryFinished = Promise.withResolvers<void>();
    const { api } = apiDouble();
    const store = createCanvasStore({ api, storage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }, isOnline: () => true });

    await store.getState().hydrate("portal-user");
    store.getState().setBootstrapRetry(async () => {
        retryCount += 1;
        await retryFinished.promise;
    });
    store.getState().markBootstrapUnavailable("portal-user", new Error("网关超时"));

    assert.equal(store.getState().bootstrapStatus, "error");
    assert.equal(store.getState().bootstrapError, "网关超时");
    assert.equal(store.getState().syncEnabled, false);
    assert.equal(store.getState().readyForCanvasMutations, true);

    const retry = store.getState().retryBootstrap();
    assert.equal(retryCount, 1);
    assert.equal(store.getState().bootstrapStatus, "loading");
    assert.equal(store.getState().bootstrapError, null);
    retryFinished.resolve();
    await retry;
    assert.equal(store.getState().bootstrapStatus, "error");
    assert.equal(store.getState().bootstrapError, "网关超时");
});

test("retains authenticated rename and delete races while adopting listed server revisions", async () => {
    const local = serverProject({ title: "本地原始标题" });
    const localValue = { ...local.document, id: local.id, title: local.title, createdAt: local.createdAt, updatedAt: local.updatedAt };
    const storage: PersistStorage<CanvasStore> = {
        getItem: async () => ({ state: { projects: [localValue], projectSync: {} } }) as never,
        setItem: async () => undefined,
        removeItem: async () => undefined,
    };
    const { api } = apiDouble();
    const renamed = createCanvasStore({ api, storage, serverDebounceMs: 10_000, isOnline: () => false });
    await renamed.getState().hydrate("portal-user");
    renamed.getState().renameProject(local.id, "列表请求期间改名");
    renamed.getState().replaceProjectsFromServer([serverProject({ revision: 4 })]);

    assert.equal(renamed.getState().openProject(local.id)?.title, "列表请求期间改名");
    assert.equal(renamed.getState().projectSync[local.id]?.dirty, true);
    assert.equal(renamed.getState().projectSync[local.id]?.serverRevision, 4);

    const deleted = createCanvasStore({ api, storage, serverDebounceMs: 10_000, isOnline: () => false });
    await deleted.getState().hydrate("portal-user");
    deleted.getState().deleteProjects([local.id]);
    deleted.getState().replaceProjectsFromServer([serverProject({ revision: 5 })]);

    assert.equal(deleted.getState().openProject(local.id), null);
    assert.equal(deleted.getState().projectSync[local.id]?.operation, "delete");
    assert.equal(deleted.getState().projectSync[local.id]?.serverRevision, 5);
});

test("adopts an imported revision cleanly only when the local snapshot has not changed", async () => {
    const calls: string[] = [];
    const { api } = apiDouble({
        create: async () => {
            calls.push("create");
            return serverProject();
        },
        update: async (id, input) => {
            calls.push(`update:${input.revision}:${input.title}`);
            return serverProject({ id, revision: input.revision + 1, title: input.title, document: input.document });
        },
    });
    const store = createCanvasStore({ api, storage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }, serverDebounceMs: 10, isOnline: () => true });
    await store.getState().hydrate("portal-user");
    const id = store.getState().createProject("导入快照");
    const snapshot = store.getState().openProject(id)!;

    store.getState().renameProject(id, "导入期间的新标题");
    store.getState().adoptImportedProjects([serverProject({ id, title: snapshot.title, revision: 7 })], new Map([[id, snapshot]]));

    assert.equal(store.getState().openProject(id)?.title, "导入期间的新标题");
    assert.equal(store.getState().projectSync[id]?.serverRevision, 7);
    assert.equal(store.getState().projectSync[id]?.dirty, true);

    store.getState().startSync("portal-user");
    await waitForDebounce();
    assert.deepEqual(calls, ["update:7:导入期间的新标题"]);

    const cleanStore = createCanvasStore({ api, storage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }, serverDebounceMs: 10, isOnline: () => true });
    await cleanStore.getState().hydrate("portal-user");
    const cleanId = cleanStore.getState().createProject("未变化快照");
    const cleanSnapshot = cleanStore.getState().openProject(cleanId)!;
    cleanStore.getState().adoptImportedProjects([serverProject({ id: cleanId, title: cleanSnapshot.title, revision: 3 })], new Map([[cleanId, cleanSnapshot]]));
    assert.equal(cleanStore.getState().projectSync[cleanId]?.dirty, false);
    assert.equal(cleanStore.getState().projectSync[cleanId]?.serverRevision, 3);
});

test("waits for an in-flight save before conflict refresh and publishes one canonical generation", async () => {
    let resolveUpdate!: (record: CanvasProjectRecord) => void;
    const update = new Promise<CanvasProjectRecord>((resolve) => (resolveUpdate = resolve));
    let getCount = 0;
    const { api } = apiDouble({
        update: async () => update,
        get: async () => {
            getCount += 1;
            return serverProject({ title: "服务器最终版本", revision: 5 });
        },
    });
    const store = createCanvasStore({ api, serverDebounceMs: 0, isOnline: () => true });
    store.getState().replaceProjectsFromServer([serverProject()]);
    store.getState().startSync("portal-user");
    const initialGeneration = store.getState().canonicalGeneration;
    store.getState().renameProject("project-1", "保存中的本地版本");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const refresh = store.getState().refreshProjectFromServer("project-1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(getCount, 0);
    resolveUpdate(serverProject({ title: "已保存版本", revision: 2 }));
    await refresh;

    assert.equal(getCount, 1);
    assert.equal(store.getState().openProject("project-1")?.title, "服务器最终版本");
    assert.equal(store.getState().canonicalGeneration, initialGeneration + 1);
    store.getState().renameProject("project-1", "普通本地修改");
    assert.equal(store.getState().canonicalGeneration, initialGeneration + 1);
});

test("normal save strips transient image URLs from the request and keeps the local preview", async () => {
    let requestDocument: CanvasProjectRecord["document"] | undefined;
    const { api } = apiDouble({
        update: async (id, input) => {
            requestDocument = input.document;
            return serverProject({ id, document: input.document, revision: 2 });
        },
    });
    const store = createCanvasStore({ api, serverDebounceMs: 0, isOnline: () => true });
    store.getState().replaceProjectsFromServer([serverProject()]);
    store.getState().startSync("portal-user");
    const node = { id: "image", type: "image", title: "图片", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { mediaId: "media-1", content: "blob:local-preview" } } as never;
    store.getState().updateProject("project-1", { nodes: [node] });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(requestDocument?.nodes[0]?.metadata?.content, undefined);
    assert.equal(store.getState().openProject("project-1")?.nodes[0]?.metadata?.content, "blob:local-preview");
});

test("a project deleted during import adopts the revision and next sync deletes instead of creating", async () => {
    const calls: string[] = [];
    const { api } = apiDouble({ delete: async (id, revision) => void calls.push(`delete:${id}:${revision}`) });
    const store = createCanvasStore({ api, storage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }, serverDebounceMs: 0, isOnline: () => true });
    await store.getState().hydrate("portal-user");
    const id = store.getState().createProject("导入后删除");
    const snapshot = store.getState().openProject(id)!;
    store.getState().deleteProjects([id]);
    store.getState().adoptImportedProjects([serverProject({ id, revision: 9 })], new Map([[id, snapshot]]));
    store.getState().startSync("portal-user");
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(calls, [`delete:${id}:9`]);
});

test("reconciles an accepted create after its response is lost and then saves newer local edits", async () => {
    let remote: CanvasProjectRecord | undefined;
    let createCount = 0;
    const calls: string[] = [];
    const { api } = apiDouble({
        create: async (input) => {
            createCount += 1;
            calls.push(`create:${input.title}`);
            if (!remote) remote = serverProject({ ...input, revision: 1 });
            if (createCount === 1) throw new Error("create response lost");
            return remote;
        },
        update: async (id, input) => {
            calls.push(`update:${input.revision}:${input.title}`);
            remote = serverProject({ id, title: input.title, document: input.document, revision: input.revision + 1 });
            return remote;
        },
    });
    const store = createCanvasStore({ api, storage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }, serverDebounceMs: 0, isOnline: () => true });
    await store.getState().hydrate("portal-user");
    store.getState().startSync("portal-user");
    const id = store.getState().createProject("首次快照");
    await new Promise((resolve) => setTimeout(resolve, 10));

    store.getState().renameProject(id, "响应丢失后的编辑");
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(calls, ["create:首次快照", "create:响应丢失后的编辑", "update:1:响应丢失后的编辑"]);
    assert.equal(remote?.title, "响应丢失后的编辑");
    assert.equal(store.getState().projectSync[id]?.serverRevision, 2);
    assert.equal(store.getState().projectSync[id]?.pending, false);
});

test("deletes a remotely accepted create when the create response is lost after a local delete", async () => {
    const createResponse = Promise.withResolvers<CanvasProjectRecord>();
    const createStarted = Promise.withResolvers<void>();
    let remoteExists = false;
    const calls: string[] = [];
    const { api } = apiDouble({
        create: async (input) => {
            remoteExists = true;
            calls.push(`create:${input.id}`);
            createStarted.resolve();
            return createResponse.promise;
        },
        delete: async (id, revision) => {
            calls.push(`delete:${id}:${revision}`);
            assert.equal(revision, 1);
            remoteExists = false;
        },
    });
    const store = createCanvasStore({ api, storage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }, serverDebounceMs: 0, isOnline: () => true });
    await store.getState().hydrate("portal-user");
    store.getState().startSync("portal-user");
    const id = store.getState().createProject("创建后立即删除");
    await createStarted.promise;

    store.getState().deleteProjects([id]);
    createResponse.reject(new Error("create response lost"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(calls, [`create:${id}`, `delete:${id}:1`]);
    assert.equal(remoteExists, false);
    assert.equal(store.getState().openProject(id), null);
    assert.equal(store.getState().projectSync[id], undefined);
});
