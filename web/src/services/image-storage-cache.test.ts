import assert from "node:assert/strict";
import test from "node:test";

import { createImagePreview, createImageStorageOperations, imagePreviewStorageKey, imageStorageKeyForMedia, imageToDataUrl, type ImageCacheStore } from "./image-storage.ts";

class MemoryStore implements ImageCacheStore {
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

function createTestOperations(options: {
    scope?: string;
    scopeVersion?: number;
    store?: MemoryStore;
    isActive?: () => boolean;
    fetchImageBlob?: (url: string) => Promise<Blob>;
    createPreviewBlob?: (blob: Blob) => Promise<Blob>;
    previewBudgetBytes?: number;
    objectUrls?: Map<string, string>;
    now?: () => number;
    readMeta?: (url: string) => Promise<{ width: number; height: number; mimeType: string }>;
}) {
    let urlSequence = 0;
    const revoked: string[] = [];
    const store = options.store || new MemoryStore();
    const operations = createImageStorageOperations({
        scope: options.scope || "portal-user-a",
        scopeVersion: options.scopeVersion || 1,
        store,
        objectUrls: options.objectUrls || new Map(),
        isActive: options.isActive || (() => true),
        fetchImageBlob: options.fetchImageBlob || (async () => new Blob(["remote"], { type: "image/png" })),
        createPreviewBlob: options.createPreviewBlob || (async () => new Blob(["preview"], { type: "image/webp" })),
        createObjectURL: () => `blob:test-${++urlSequence}`,
        revokeObjectURL: (url) => revoked.push(url),
        readMeta: options.readMeta || (async () => ({ width: 640, height: 480, mimeType: "image/png" })),
        now: options.now || (() => 1234),
        previewBudgetBytes: options.previewBudgetBytes,
    });
    return { operations, revoked, store };
}

function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}

test("original and preview variants keep the existing stable cache keys", () => {
    assert.equal(imageStorageKeyForMedia("media-1"), "media:media-1");
    assert.equal(imagePreviewStorageKey("media-1"), "preview:media-1");
});

test("loadMediaImage uses a cached original without fetching the remote URL", async () => {
    const store = new MemoryStore();
    await store.setItem("media:media-1", new Blob(["cached"], { type: "image/png" }));
    let remoteCalls = 0;
    const { operations } = createTestOperations({
        store,
        fetchImageBlob: async () => {
            remoteCalls += 1;
            return new Blob(["remote"], { type: "image/png" });
        },
    });

    const image = await operations.loadMediaImage("media-1", "https://oss.example/original.png");

    assert.equal(image.storageKey, "media:media-1");
    assert.equal(remoteCalls, 0);
});

test("loadMediaPreview derives and stores a WebP preview from the local original without a remote fetch", async () => {
    const store = new MemoryStore();
    const original = new Blob(["cached-original"], { type: "image/png" });
    const derived = new Blob(["derived-preview"], { type: "image/webp" });
    await store.setItem("media:media-2", original);
    let remoteCalls = 0;
    let derivedFrom: Blob | undefined;
    const { operations } = createTestOperations({
        store,
        createPreviewBlob: async (blob) => {
            derivedFrom = blob;
            return derived;
        },
        fetchImageBlob: async () => {
            remoteCalls += 1;
            return new Blob(["remote"], { type: "image/webp" });
        },
    });

    const image = await operations.loadMediaPreview("media-2", "https://oss.example/preview.webp");

    assert.equal(image.storageKey, "preview:media-2");
    assert.equal(derivedFrom, original);
    assert.equal(await store.getItem("preview:media-2"), derived);
    assert.equal(remoteCalls, 0);
});

test("loadMediaPreview falls back to the cached original when browser conversion fails", async () => {
    const store = new MemoryStore();
    const original = new Blob(["cached-original"], { type: "image/png" });
    await store.setItem("media:media-3", original);
    let remoteCalls = 0;
    const { operations } = createTestOperations({
        store,
        createPreviewBlob: async () => {
            throw new Error("WebP conversion unavailable");
        },
        fetchImageBlob: async () => {
            remoteCalls += 1;
            return new Blob(["remote"], { type: "image/webp" });
        },
    });

    const image = await operations.loadMediaPreview("media-3", "https://oss.example/preview.webp");

    assert.equal(image.storageKey, "media:media-3");
    assert.equal(remoteCalls, 0);
});

test("cache hits do not create an access URL and cache misses create it only when downloading", async () => {
    const store = new MemoryStore();
    await store.setItem("media:media-local", new Blob(["cached-original"], { type: "image/png" }));
    let accessRequests = 0;
    const receivedURLs: string[] = [];
    const { operations } = createTestOperations({
        store,
        fetchImageBlob: async (url) => {
            receivedURLs.push(url);
            return new Blob(["remote"], { type: "image/png" });
        },
    });
    const requestAccess = async () => {
        accessRequests += 1;
        return "https://oss.example/original.png";
    };

    await operations.loadMediaImage("media-local", requestAccess);
    assert.equal(accessRequests, 0);

    await operations.loadMediaImage("media-missing", requestAccess);
    assert.equal(accessRequests, 1);
    assert.deepEqual(receivedURLs, ["https://oss.example/original.png"]);
});

test("single-flight keys are scope-qualified", async () => {
    const remoteResolvers: Array<(blob: Blob) => void> = [];
    let remoteCalls = 0;
    const fetchImageBlob = () => {
        remoteCalls += 1;
        return new Promise<Blob>((resolve) => {
            remoteResolvers.push(resolve);
        });
    };
    const firstScope = createTestOperations({ scope: "portal-user-a", fetchImageBlob });
    const secondScope = createTestOperations({ scope: "portal-user-b", fetchImageBlob });

    const first = firstScope.operations.loadMediaImage("shared-id", "https://oss.example/a.png");
    const duplicate = firstScope.operations.loadMediaImage("shared-id", "https://oss.example/a.png");
    const otherUser = secondScope.operations.loadMediaImage("shared-id", "https://oss.example/b.png");

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(remoteCalls, 2);
    remoteResolvers.forEach((resolve) => resolve(new Blob(["remote"], { type: "image/png" })));
    await Promise.all([first, duplicate, otherUser]);
});

test("a request started in an old scope never writes after that scope becomes inactive", async () => {
    const store = new MemoryStore();
    let active = true;
    let resolveRemote: ((blob: Blob) => void) | undefined;
    const { operations } = createTestOperations({
        store,
        isActive: () => active,
        fetchImageBlob: () =>
            new Promise((resolve) => {
                resolveRemote = resolve;
            }),
    });

    const pending = operations.loadMediaImage("media-stale", "https://oss.example/stale.png");
    active = false;
    resolveRemote?.(new Blob(["remote"], { type: "image/png" }));

    await assert.rejects(pending, /缓存作用域已切换/);
    assert.equal(await store.getItem("media:media-stale"), null);
});

test("explicit deletion invalidates a pending original download before it can repopulate the cache", async () => {
    const store = new MemoryStore();
    let resolveRemote: ((blob: Blob) => void) | undefined;
    const { operations } = createTestOperations({
        store,
        fetchImageBlob: () =>
            new Promise((resolve) => {
                resolveRemote = resolve;
            }),
    });

    const pending = operations.loadMediaImage("delete-original", "https://oss.example/original.png");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await operations.deleteStoredImages(["media:delete-original"]);
    resolveRemote?.(new Blob(["late-original"], { type: "image/png" }));

    await assert.rejects(pending, /缓存已删除/);
    assert.equal(await store.getItem("media:delete-original"), null);
    assert.equal(await store.getItem("preview:delete-original"), null);
});

test("explicit deletion invalidates a pending preview download and its metadata", async () => {
    const store = new MemoryStore();
    let resolveRemote: ((blob: Blob) => void) | undefined;
    const { operations } = createTestOperations({
        store,
        fetchImageBlob: () =>
            new Promise((resolve) => {
                resolveRemote = resolve;
            }),
    });

    const pending = operations.loadMediaPreview("delete-preview", "https://oss.example/preview.webp");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await operations.deleteStoredImages(["media:delete-preview"]);
    resolveRemote?.(new Blob(["late-preview"], { type: "image/webp" }));

    await assert.rejects(pending, /缓存已删除/);
    assert.equal(await store.getItem("preview:delete-preview"), null);
    assert.equal(await store.getItem("preview-meta:delete-preview"), null);
});

test("an invalidated partial write cannot erase a newer generation written after deletion", async () => {
    const store = new MemoryStore();
    const writeStoredItem = store.setItem.bind(store);
    let firstWriteStarted: (() => void) | undefined;
    let releaseFirstWrite: (() => void) | undefined;
    let mediaWrites = 0;
    store.setItem = async <T>(key: string, value: T) => {
        if (key === "media:replace-after-delete") {
            mediaWrites += 1;
            if (mediaWrites === 1) {
                firstWriteStarted?.();
                await new Promise<void>((resolve) => {
                    releaseFirstWrite = resolve;
                });
            }
        }
        return writeStoredItem(key, value);
    };
    const firstWriteReady = new Promise<void>((resolve) => {
        firstWriteStarted = resolve;
    });
    const { operations } = createTestOperations({
        store,
        fetchImageBlob: async (url) => new Blob([url.includes("new") ? "new" : "old"], { type: "image/png" }),
    });

    const oldLoad = operations.loadMediaImage("replace-after-delete", "https://oss.example/old.png");
    await firstWriteReady;
    const deletion = operations.deleteStoredImages(["media:replace-after-delete"]);
    const newLoad = operations.loadMediaImage("replace-after-delete", "https://oss.example/new.png");
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirstWrite?.();

    await deletion;
    await assert.rejects(oldLoad, /缓存已删除/);
    await newLoad;
    const stored = await store.getItem<Blob>("media:replace-after-delete");
    assert.equal(await stored?.text(), "new");
});

test("an old A context cannot overwrite a newer A context after A → B → A", async () => {
    const store = new MemoryStore();
    const writeStoredItem = store.setItem.bind(store);
    const oldWriteStarted = deferred<void>();
    const releaseOldWrite = deferred<void>();
    store.setItem = async <T>(key: string, value: T) => {
        if (key === "media:return-to-a" && value instanceof Blob && (await value.text()) === "old") {
            oldWriteStarted.resolve();
            await releaseOldWrite.promise;
        }
        return writeStoredItem(key, value);
    };

    let oldContextActive = true;
    const oldA = createTestOperations({
        scope: "portal-user-a",
        scopeVersion: 1,
        store,
        isActive: () => oldContextActive,
        fetchImageBlob: async () => new Blob(["old"], { type: "image/png" }),
    });
    const staleLoad = oldA.operations.loadMediaImage("return-to-a", "https://oss.example/old.png");
    await oldWriteStarted.promise;

    oldContextActive = false;
    const newA = createTestOperations({
        scope: "portal-user-a",
        scopeVersion: 3,
        store,
        fetchImageBlob: async () => new Blob(["new"], { type: "image/png" }),
    });
    const freshLoad = newA.operations.loadMediaImage("return-to-a", "https://oss.example/new.png");
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseOldWrite.resolve();

    await assert.rejects(staleLoad, /缓存作用域已切换/);
    await freshLoad;
    const stored = await store.getItem<Blob>("media:return-to-a");
    assert.equal(await stored?.text(), "new");
});

test("deleting a temporary source while promote is writing never creates the target media", async () => {
    const store = new MemoryStore();
    const sourceKey = "image:temporary-source";
    const targetKey = "media:promoted-after-delete";
    const source = new Blob(["source"], { type: "image/png" });
    await store.setItem(sourceKey, source);
    const writeStoredItem = store.setItem.bind(store);
    const targetWriteStarted = deferred<void>();
    const releaseTargetWrite = deferred<void>();
    store.setItem = async <T>(key: string, value: T) => {
        if (key === targetKey) {
            targetWriteStarted.resolve();
            await releaseTargetWrite.promise;
        }
        return writeStoredItem(key, value);
    };
    const { operations } = createTestOperations({ store });

    const pending = operations.promoteImageStorageKey(
        {
            url: "blob:temporary-source",
            storageKey: sourceKey,
            width: 640,
            height: 480,
            bytes: source.size,
            mimeType: source.type,
        },
        "promoted-after-delete",
    );
    await targetWriteStarted.promise;
    const deletion = operations.deleteStoredImages([sourceKey]);
    releaseTargetWrite.resolve();

    await deletion;
    await assert.rejects(pending, /缓存已删除/);
    assert.equal(await store.getItem(targetKey), null);
});

test("cleanup does not remove a storeImage write that is in progress", async () => {
    const store = new MemoryStore();
    const storageKey = "image:store-in-progress";
    await store.setItem(storageKey, new Blob(["old"]));
    const writeStoredItem = store.setItem.bind(store);
    const removals: string[] = [];
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    store.setItem = async <T>(key: string, value: T) => {
        if (key === storageKey && value instanceof Blob && (await value.text()) === "new") {
            writeStarted.resolve();
            await releaseWrite.promise;
        }
        return writeStoredItem(key, value);
    };
    const removeStoredItem = store.removeItem.bind(store);
    store.removeItem = async (key: string) => {
        removals.push(key);
        await removeStoredItem(key);
    };
    const { operations } = createTestOperations({ store });

    const pending = operations.storeImage(new Blob(["new"]), storageKey);
    await writeStarted.promise;
    await operations.cleanupUnusedImages({});
    assert.equal(removals.includes(storageKey), false);
    releaseWrite.resolve();
    await pending;
});

test("cleanup does not remove a setImageBlob write that is in progress", async () => {
    const store = new MemoryStore();
    const storageKey = "media:set-in-progress";
    await store.setItem(storageKey, new Blob(["old"]));
    const writeStoredItem = store.setItem.bind(store);
    const removals: string[] = [];
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    store.setItem = async <T>(key: string, value: T) => {
        if (key === storageKey && value instanceof Blob && (await value.text()) === "new") {
            writeStarted.resolve();
            await releaseWrite.promise;
        }
        return writeStoredItem(key, value);
    };
    const removeStoredItem = store.removeItem.bind(store);
    store.removeItem = async (key: string) => {
        removals.push(key);
        await removeStoredItem(key);
    };
    const { operations } = createTestOperations({ store });

    const pending = operations.setImageBlob(storageKey, new Blob(["new"]));
    await writeStarted.promise;
    await operations.cleanupUnusedImages({});
    assert.equal(removals.includes(storageKey), false);
    releaseWrite.resolve();
    await pending;
});

test("cleanup does not remove a promote source while its target write is in progress", async () => {
    const store = new MemoryStore();
    const sourceKey = "image:promote-in-progress";
    const targetKey = "media:promote-in-progress";
    const source = new Blob(["source"], { type: "image/png" });
    await store.setItem(sourceKey, source);
    const writeStoredItem = store.setItem.bind(store);
    const removals: string[] = [];
    const targetWriteStarted = deferred<void>();
    const releaseTargetWrite = deferred<void>();
    store.setItem = async <T>(key: string, value: T) => {
        if (key === targetKey) {
            targetWriteStarted.resolve();
            await releaseTargetWrite.promise;
        }
        return writeStoredItem(key, value);
    };
    const removeStoredItem = store.removeItem.bind(store);
    store.removeItem = async (key: string) => {
        removals.push(key);
        await removeStoredItem(key);
    };
    const { operations } = createTestOperations({ store });

    const pending = operations.promoteImageStorageKey(
        {
            url: "blob:promote-in-progress",
            storageKey: sourceKey,
            width: 640,
            height: 480,
            bytes: source.size,
            mimeType: source.type,
        },
        "promote-in-progress",
    );
    await targetWriteStarted.promise;
    await operations.cleanupUnusedImages({});
    assert.equal(removals.includes(sourceKey), false);
    assert.equal(removals.includes(targetKey), false);
    releaseTargetWrite.resolve();
    await pending;
    assert.equal(await store.getItem(sourceKey), null);
    assert.ok(await store.getItem(targetKey));
});

test("generic cleanup retains previews, explicit media deletion removes both variants", async () => {
    const store = new MemoryStore();
    await store.setItem("media:unused", new Blob(["original"]));
    await store.setItem("preview:unused", new Blob(["preview"]));
    const { operations } = createTestOperations({ store });

    await operations.cleanupUnusedImages({});
    assert.equal(await store.getItem("media:unused"), null);
    assert.ok(await store.getItem("preview:unused"));

    await operations.deleteStoredImages(["media:unused"]);
    assert.equal(await store.getItem("preview:unused"), null);
});

test("generic cleanup evicts only the least-recently-used previews above the preview budget", async () => {
    const store = new MemoryStore();
    await store.setItem("preview:old", new Blob(["old"]));
    await store.setItem("preview-meta:old", { bytes: 3, lastAccess: 1 });
    await store.setItem("preview:new", new Blob(["new"]));
    await store.setItem("preview-meta:new", { bytes: 3, lastAccess: 2 });
    const { operations } = createTestOperations({ store, previewBudgetBytes: 3 });

    await operations.cleanupUnusedImages({});

    assert.equal(await store.getItem("preview:old"), null);
    assert.ok(await store.getItem("preview:new"));
});

test("preview budget eviction removes the least-recently-used preview even when its original is still referenced", async () => {
    const store = new MemoryStore();
    const oldPreview = new Blob(["old"]);
    await store.setItem("media:old", new Blob(["original"]));
    await store.setItem("preview:old", oldPreview);
    await store.setItem("preview-meta:old", { bytes: oldPreview.size, lastAccess: 1 });
    await store.setItem("preview:new", new Blob(["new"]));
    await store.setItem("preview-meta:new", { bytes: 3, lastAccess: 2 });
    const { operations, revoked } = createTestOperations({
        store,
        previewBudgetBytes: 3,
        objectUrls: new Map([["preview:old", "blob:old-preview"]]),
    });

    await operations.enforcePreviewCacheBudget();

    assert.ok(await store.getItem("media:old"));
    assert.equal(await store.getItem("preview:old"), null);
    assert.equal(await store.getItem("preview-meta:old"), null);
    assert.deepEqual(revoked, ["blob:old-preview"]);
    assert.ok(await store.getItem("preview:new"));
});

test("a successful preview write schedules low-priority budget eviction", async () => {
    const store = new MemoryStore();
    await store.setItem("preview:old", new Blob(["old"]));
    await store.setItem("preview-meta:old", { bytes: 3, lastAccess: 1 });
    const { operations } = createTestOperations({
        store,
        previewBudgetBytes: 3,
        now: () => 2,
        fetchImageBlob: async () => new Blob(["new"], { type: "image/webp" }),
    });

    await operations.loadMediaPreview("new", "https://oss.example/new.webp");
    for (let attempt = 0; attempt < 10 && (await store.getItem("preview:old")); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.equal(await store.getItem("preview:old"), null);
    assert.ok(await store.getItem("preview:new"));
});

test("preview writes from separate operations in one scope share a single scheduled budget scan", async () => {
    const store = new MemoryStore();
    const iterate = store.iterate.bind(store);
    let scans = 0;
    store.iterate = async <T, U>(iterator: (value: T, key: string, iterationNumber: number) => U | void) => {
        scans += 1;
        return iterate(iterator);
    };
    const first = createTestOperations({ scope: "shared-preview-scope", store, fetchImageBlob: async () => new Blob(["one"], { type: "image/webp" }) });
    const second = createTestOperations({ scope: "shared-preview-scope", store, fetchImageBlob: async () => new Blob(["two"], { type: "image/webp" }) });

    await Promise.all([
        first.operations.loadMediaPreview("preview-one", "https://oss.example/one.webp"),
        second.operations.loadMediaPreview("preview-two", "https://oss.example/two.webp"),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(scans, 1);
});

test("the final concurrent preview completion schedules budget eviction after earlier in-flight passes", async () => {
    const store = new MemoryStore();
    const remoteBlobs = new Map<string, ReturnType<typeof deferred<Blob>>>();
    const secondMetadataStarted = deferred<void>();
    const secondMetadata = deferred<{ width: number; height: number; mimeType: string }>();
    let metadataCalls = 0;
    let clock = 0;
    const { operations } = createTestOperations({
        store,
        previewBudgetBytes: 3,
        now: () => ++clock,
        fetchImageBlob: (url) => {
            const pending = deferred<Blob>();
            remoteBlobs.set(url, pending);
            return pending.promise;
        },
        readMeta: async () => {
            metadataCalls += 1;
            if (metadataCalls === 2) {
                secondMetadataStarted.resolve();
                return secondMetadata.promise;
            }
            return { width: 640, height: 480, mimeType: "image/webp" };
        },
    });

    const first = operations.loadMediaPreview("first", "https://oss.example/first.webp");
    const second = operations.loadMediaPreview("second", "https://oss.example/second.webp");
    for (let attempt = 0; attempt < 5 && (!remoteBlobs.get("https://oss.example/first.webp") || !remoteBlobs.get("https://oss.example/second.webp")); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    remoteBlobs.get("https://oss.example/first.webp")?.resolve(new Blob(["one"], { type: "image/webp" }));
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    remoteBlobs.get("https://oss.example/second.webp")?.resolve(new Blob(["two"], { type: "image/webp" }));
    await secondMetadataStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(await store.getItem("preview:first"));
    assert.ok(await store.getItem("preview:second"));

    secondMetadata.resolve({ width: 640, height: 480, mimeType: "image/webp" });
    await second;
    for (let attempt = 0; attempt < 10 && (await store.getItem("preview:first")); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.equal(await store.getItem("preview:first"), null);
    assert.ok(await store.getItem("preview:second"));
});

test("preview budget eviction leaves a preview in flight untouched", async () => {
    const store = new MemoryStore();
    await store.setItem("preview:loading", new Blob(["loading"]));
    await store.setItem("preview-meta:loading", { bytes: 7, lastAccess: 1 });
    const metadata = deferred<{ width: number; height: number; mimeType: string }>();
    const metadataStarted = deferred<void>();
    const { operations } = createTestOperations({
        store,
        previewBudgetBytes: 0,
        readMeta: async () => {
            metadataStarted.resolve();
            return metadata.promise;
        },
    });

    const pending = operations.loadMediaPreview("loading", "https://oss.example/loading.webp");
    await metadataStarted.promise;
    await operations.enforcePreviewCacheBudget();

    assert.ok(await store.getItem("preview:loading"));
    metadata.resolve({ width: 640, height: 480, mimeType: "image/webp" });
    await pending;
});

test("an Object URL preview hit updates LRU metadata without blocking display", async () => {
    const store = new MemoryStore();
    await store.setItem("preview:memory-hit", new Blob(["preview"], { type: "image/webp" }));
    await store.setItem("preview-meta:memory-hit", { bytes: 7, lastAccess: 1 });
    const writeStoredItem = store.setItem.bind(store);
    let releaseMetadataWrite: (() => void) | undefined;
    store.setItem = async <T>(key: string, value: T) => {
        if (key === "preview-meta:memory-hit") {
            await new Promise<void>((resolve) => {
                releaseMetadataWrite = resolve;
            });
        }
        return writeStoredItem(key, value);
    };
    const { operations } = createTestOperations({
        store,
        objectUrls: new Map([["preview:memory-hit", "blob:cached-preview"]]),
        now: () => 999,
    });

    const result = await Promise.race([operations.resolveImageUrl("preview:memory-hit"), new Promise<string>((_, reject) => setTimeout(() => reject(new Error("预览显示被元数据写入阻塞")), 20))]);
    assert.equal(result, "blob:cached-preview");

    for (let attempt = 0; attempt < 5 && !releaseMetadataWrite; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(releaseMetadataWrite);
    releaseMetadataWrite?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(await store.getItem("preview-meta:memory-hit"), { bytes: 7, lastAccess: 999 });
});

test("generic cleanup does not delete a media key while its remote load is in flight", async () => {
    const store = new MemoryStore();
    await store.setItem("media:loading", new Blob(["stale"], { type: "image/png" }));
    const readStoredItem = store.getItem.bind(store);
    let simulateCacheMiss = true;
    store.getItem = async <T>(key: string) => {
        if (key === "media:loading" && simulateCacheMiss) {
            simulateCacheMiss = false;
            return null;
        }
        return readStoredItem<T>(key);
    };
    let resolveRemote: ((blob: Blob) => void) | undefined;
    const { operations } = createTestOperations({
        store,
        fetchImageBlob: () =>
            new Promise((resolve) => {
                resolveRemote = resolve;
            }),
    });

    const pending = operations.loadMediaImage("loading", "https://oss.example/loading.png");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await operations.cleanupUnusedImages({});
    assert.ok(await store.getItem("media:loading"));
    resolveRemote?.(new Blob(["remote"], { type: "image/png" }));
    const image = await pending;

    assert.equal(image.storageKey, "media:loading");
    assert.ok(await store.getItem("media:loading"));
});

test("cleanup keeps an original protected until every overlapping original and preview load finishes", async () => {
    const store = new MemoryStore();
    const readStoredItem = store.getItem.bind(store);
    let mediaMissesRemaining = 2;
    store.getItem = async <T>(key: string) => {
        if (key === "media:shared-reference" && mediaMissesRemaining > 0) {
            mediaMissesRemaining -= 1;
            return null;
        }
        return readStoredItem<T>(key);
    };
    const resolvers = new Map<string, (blob: Blob) => void>();
    const { operations } = createTestOperations({
        store,
        fetchImageBlob: (url) =>
            new Promise((resolve) => {
                resolvers.set(url, resolve);
            }),
    });

    const original = operations.loadMediaImage("shared-reference", "https://oss.example/original.png");
    const preview = operations.loadMediaPreview("shared-reference", "https://oss.example/preview.webp");
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolvers.get("https://oss.example/original.png")?.(new Blob(["original"], { type: "image/png" }));
    await original;

    await operations.cleanupUnusedImages({});
    assert.ok(await store.getItem("media:shared-reference"));

    resolvers.get("https://oss.example/preview.webp")?.(new Blob(["preview"], { type: "image/webp" }));
    await preview;
});

test("replacing a cached object URL revokes the obsolete URL once", async () => {
    const { operations, revoked } = createTestOperations({});

    const first = await operations.setImageBlob("media:replace", new Blob(["first"]));
    const second = await operations.setImageBlob("media:replace", new Blob(["second"]));

    assert.notEqual(first, second);
    assert.deepEqual(revoked, [first]);
});

test("overwriting an image through storeImage replaces its object URL", async () => {
    const { operations, revoked } = createTestOperations({});

    const first = await operations.storeImage(new Blob(["first"]), "media:store-replace", "store-replace");
    const second = await operations.storeImage(new Blob(["second"]), "media:store-replace", "store-replace");

    assert.notEqual(first.url, second.url);
    assert.deepEqual(revoked, [first.url]);
});

test("promoting an already-stable media key is idempotent and keeps the target blob", async () => {
    const store = new MemoryStore();
    const blob = new Blob(["stable"], { type: "image/png" });
    await store.setItem("media:already-stable", blob);
    const { operations } = createTestOperations({
        store,
        objectUrls: new Map([["media:already-stable", "blob:already-stable"]]),
    });

    const promoted = await operations.promoteImageStorageKey(
        {
            url: "blob:already-stable",
            storageKey: "media:already-stable",
            width: 640,
            height: 480,
            bytes: blob.size,
            mimeType: blob.type,
            mediaId: "already-stable",
        },
        "already-stable",
    );

    assert.equal(promoted.storageKey, "media:already-stable");
    assert.equal(await store.getItem("media:already-stable"), blob);
});

test("imageToDataUrl preserves an already-inline data URL", async () => {
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    assert.equal(await imageToDataUrl({ dataUrl }), dataUrl);
});

test("createImagePreview generates a 320px WebP at 0.8 quality", async () => {
    const globals = globalThis as unknown as {
        createImageBitmap?: (blob: Blob) => Promise<{ width: number; height: number; close: () => void }>;
        OffscreenCanvas?: new (
            width: number,
            height: number,
        ) => {
            getContext: () => { drawImage: (...args: unknown[]) => void };
            convertToBlob: (options: { type: string; quality: number }) => Promise<Blob>;
        };
    };
    const originalBitmap = globals.createImageBitmap;
    const originalCanvas = globals.OffscreenCanvas;
    let canvasSize: [number, number] | undefined;
    let conversionOptions: { type: string; quality: number } | undefined;
    let closed = false;

    globals.createImageBitmap = async () => ({ width: 640, height: 320, close: () => (closed = true) });
    globals.OffscreenCanvas = class {
        constructor(width: number, height: number) {
            canvasSize = [width, height];
        }
        getContext() {
            return { drawImage: () => undefined };
        }
        async convertToBlob(options: { type: string; quality: number }) {
            conversionOptions = options;
            return new Blob(["preview"], { type: "image/webp" });
        }
    };

    try {
        const preview = await createImagePreview(new Blob(["original"], { type: "image/png" }));
        assert.equal(preview.type, "image/webp");
        assert.deepEqual(canvasSize, [320, 160]);
        assert.deepEqual(conversionOptions, { type: "image/webp", quality: 0.8 });
        assert.equal(closed, true);
    } finally {
        globals.createImageBitmap = originalBitmap;
        globals.OffscreenCanvas = originalCanvas;
    }
});
