import assert from "node:assert/strict";
import test from "node:test";

import type { StateStorage, StorageValue } from "zustand/middleware";
import { createFileStorageOperations } from "@/services/file-storage";
import { createImageStorageOperations, type ImageCacheStore } from "@/services/image-storage";
import { CanvasNodeType } from "../types";
import { createCanvasStorage, createCanvasStore, type CanvasProject, type CanvasStore } from "./use-canvas-store";

class MemoryImageStore implements ImageCacheStore {
    readonly values = new Map<string, unknown>();

    async getItem<T>(key: string) {
        return (this.values.get(key) as T | undefined) ?? null;
    }

    async setItem<T>(key: string, value: T) {
        this.values.set(key, value);
        return value;
    }

    async removeItem(key: string) {
        this.values.delete(key);
    }

    async iterate<T, U>(iterator: (value: T, key: string, iterationNumber: number) => U | void) {
        let iteration = 1;
        for (const [key, value] of this.values) {
            const result = iterator(value as T, key, iteration++);
            if (result !== undefined) return result;
        }
        return undefined;
    }
}

function memoryStateStorage() {
    const values = new Map<string, string>();
    const storage: StateStorage = {
        getItem: async (key) => values.get(key) ?? null,
        setItem: async (key, value) => {
            values.set(key, value);
        },
        removeItem: async (key) => {
            values.delete(key);
        },
    };
    return storage;
}

const project: CanvasProject = {
    id: "cached-dirty",
    title: "本地待保存画布",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    nodes: [
        {
            id: "pending-image",
            type: CanvasNodeType.Image,
            title: "待上传图片",
            position: { x: 0, y: 0 },
            width: 320,
            height: 240,
            metadata: { content: "blob:pending-image", storageKey: "image:pending-local", localUploadState: "uploading" },
        },
        {
            id: "local-video",
            type: CanvasNodeType.Video,
            title: "本地视频",
            position: { x: 360, y: 0 },
            width: 320,
            height: 180,
            metadata: { content: "blob:pending-video", storageKey: "video:pending-local", mimeType: "video/mp4" },
        },
    ],
    connections: [],
    maskResources: {},
    backgroundMode: "lines",
    showImageInfo: false,
    viewport: { x: 20, y: 30, k: 0.9 },
};

const summaries = [
    { id: project.id, title: "服务器目录标题", revision: 9, createdAt: project.createdAt, updatedAt: "2026-09-03T00:00:00Z", nodeCount: 1, connectionCount: 0 },
    { id: "remote-unopened", title: "未加载详情", revision: 4, createdAt: project.createdAt, updatedAt: "2026-09-04T00:00:00Z", nodeCount: 12, connectionCount: 8 },
];

async function restoredSummaryStore() {
    const backing = memoryStateStorage();
    const storageName = "infinite-canvas:canvas_store:owner";
    const seed = createCanvasStorage({
        ...backing,
        getItems: async (keys) => Promise.all(keys.map((key) => backing.getItem(key))),
        setItems: async (entries) => {
            for (const [key, value] of entries) await backing.setItem(key, value);
        },
    });
    await seed.setItem(storageName, {
        state: {
            projects: [project],
            summaries,
            projectSync: {
                [project.id]: {
                    serverRevision: 3,
                    dirty: true,
                    pending: true,
                    saving: false,
                    offline: true,
                    error: null,
                    conflict: false,
                    operation: "save",
                },
            },
        },
    } as StorageValue<CanvasStore>);

    const store = createCanvasStore({
        storage: createCanvasStorage({
            ...backing,
            getItems: async (keys) => Promise.all(keys.map((key) => backing.getItem(key))),
            setItems: async (entries) => {
                for (const [key, value] of entries) await backing.setItem(key, value);
            },
        }),
        isOnline: () => false,
        api: {
            list: async () => ({ items: [], total: 0 }),
            get: async () => {
                throw new Error("cleanup inventory must not load a remote detail");
            },
            create: async () => {
                throw new Error("unexpected create");
            },
            importProjects: async () => ({ items: [], total: 0 }),
            update: async () => {
                throw new Error("unexpected update");
            },
            delete: async () => {},
        },
    });
    await store.getState().hydrate("owner");
    store.getState().mergeProjectSummaries(summaries);
    return store;
}

test("summary persistence roundtrip retains dirty full documents without materializing unopened details", async () => {
    const store = await restoredSummaryStore();
    const state = store.getState();

    assert.equal(state.openProject("remote-unopened"), null);
    assert.equal(state.projects.length, 1);
    assert.deepEqual(
        state.projects[0]?.nodes.map((node) => node.metadata?.storageKey),
        ["image:pending-local", "video:pending-local"],
    );
    assert.equal(state.projectSync[project.id]?.serverRevision, 3);
    assert.equal(state.projectSync[project.id]?.dirty, true);
    assert.equal(state.summaries.find((item) => item.id === project.id)?.revision, 9);
});

test("real image and video cleanup retain references from cached dirty documents", async () => {
    const store = await restoredSummaryStore();
    const usedData = { projects: store.getState().projects };

    const images = new MemoryImageStore();
    await images.setItem("image:pending-local", new Blob(["pending image"]));
    await images.setItem("image:unused", new Blob(["unused image"]));
    const imageOperations = createImageStorageOperations({
        scope: "summary-media-test",
        scopeVersion: 1,
        store: images,
        objectUrls: new Map(),
        isActive: () => true,
    });

    const videoValues = new Map<string, Blob>([
        ["video:pending-local", new Blob(["pending video"], { type: "video/mp4" })],
        ["video:unused", new Blob(["unused video"], { type: "video/mp4" })],
    ]);
    const videoOperations = createFileStorageOperations({
        getItem: async (key) => videoValues.get(key) ?? null,
        setItem: async (key, value) => {
            videoValues.set(key, value);
            return value;
        },
        removeItem: async (key) => {
            videoValues.delete(key);
        },
        iterate: async (visit) => {
            for (const [key, value] of videoValues) visit(value, key);
        },
    });

    await Promise.all([imageOperations.cleanupUnusedImages(usedData), videoOperations.cleanupUnusedMedia(usedData)]);

    assert.ok(await images.getItem("image:pending-local"));
    assert.equal(await images.getItem("image:unused"), null);
    assert.ok(videoValues.has("video:pending-local"));
    assert.equal(videoValues.has("video:unused"), false);
});
