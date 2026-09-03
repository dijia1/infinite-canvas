import assert from "node:assert/strict";
import test from "node:test";

import { createImagePreview, createImageStorageOperations, imageStorageKeyForMedia, imageThumbnailStorageKey, imageToDataUrl, mediaIdFromImageStorageKey, type ImageCacheStore } from "./image-storage.ts";

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
    fetchImageBlob?: (url: string, options?: { signal?: AbortSignal }) => Promise<Blob>;
    createPreviewBlob?: (blob: Blob) => Promise<Blob>;
    cacheBudgetBytes?: number;
    cacheHighWatermarkBytes?: number;
    cacheLowWatermarkBytes?: number;
    cacheHighWatermarkEntries?: number;
    cacheLowWatermarkEntries?: number;
    objectUrls?: Map<string, string>;
    createObjectURL?: (blob: Blob) => string;
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
        createObjectURL: options.createObjectURL || (() => `blob:test-${++urlSequence}`),
        revokeObjectURL: (url) => revoked.push(url),
        readMeta: options.readMeta || (async () => ({ width: 640, height: 480, mimeType: "image/png" })),
        now: options.now || (() => 1234),
        cacheBudgetBytes: options.cacheBudgetBytes,
        cacheHighWatermarkBytes: options.cacheHighWatermarkBytes,
        cacheLowWatermarkBytes: options.cacheLowWatermarkBytes,
        cacheHighWatermarkEntries: options.cacheHighWatermarkEntries,
        cacheLowWatermarkEntries: options.cacheLowWatermarkEntries,
    } as Parameters<typeof createImageStorageOperations>[0] & {
        cacheHighWatermarkEntries?: number;
        cacheLowWatermarkEntries?: number;
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

test("original and thumbnail variants use versioned stable cache keys", () => {
    assert.equal(imageStorageKeyForMedia("media-1"), "media:media-1:v1:original");
    assert.equal(imageThumbnailStorageKey("media-1"), "media:media-1:v1:thumbnail");
});

test("extracts only persistent media IDs from image storage keys", () => {
    assert.equal(mediaIdFromImageStorageKey("media:media-1:v1:original"), "media-1");
    assert.equal(mediaIdFromImageStorageKey("media:legacy-media"), "legacy-media");
    assert.equal(mediaIdFromImageStorageKey("image:temporary-image"), undefined);
});

test("migrates a legacy original cache entry without fetching its signed URL", async () => {
    const store = new MemoryStore();
    const legacy = new Blob(["legacy"], { type: "image/png" });
    await store.setItem("media:legacy-media", legacy);
    let accessRequests = 0;
    const { operations } = createTestOperations({ store, fetchImageBlob: async () => new Blob(["remote"], { type: "image/png" }) });

    const image = await operations.loadMediaImage("legacy-media", async () => {
        accessRequests += 1;
        return "https://oss.example/original.png";
    });

    assert.equal(accessRequests, 0);
    assert.equal(image.storageKey, "media:legacy-media:v1:original");
    assert.equal(await store.getItem("media:legacy-media"), null);
    assert.equal(await store.getItem("media:legacy-media:v1:original"), legacy);
});

test("migrates a legacy thumbnail cache entry without fetching its signed URL", async () => {
    const store = new MemoryStore();
    const legacy = new Blob(["legacy-thumbnail"], { type: "image/webp" });
    await store.setItem("preview:legacy-media", legacy);
    let accessRequests = 0;
    const { operations } = createTestOperations({ store, fetchImageBlob: async () => new Blob(["remote"], { type: "image/webp" }) });

    const image = await operations.loadMediaThumbnail("legacy-media", async () => {
        accessRequests += 1;
        return "https://oss.example/thumbnail.webp";
    });

    assert.equal(accessRequests, 0);
    assert.equal(image.storageKey, "media:legacy-media:v1:thumbnail");
    assert.equal(await store.getItem("preview:legacy-media"), null);
    assert.equal(await store.getItem("media:legacy-media:v1:thumbnail"), legacy);
});

test("replaces a cached original incorrectly stored as a strict canvas thumbnail", async () => {
    const store = new MemoryStore();
    const staleOriginal = new Blob(["stale-original"], { type: "image/jpeg" });
    const compactPreview = new Blob(["compact-preview"], { type: "image/webp" });
    await store.setItem(imageThumbnailStorageKey("strict-thumbnail"), staleOriginal);

    const labels = new Map<Blob, string>([
        [staleOriginal, "stale-original"],
        [compactPreview, "compact-preview"],
    ]);
    let remoteFetches = 0;
    const { operations } = createTestOperations({
        store,
        fetchImageBlob: async () => {
            remoteFetches += 1;
            return compactPreview;
        },
        createObjectURL: (blob) => `blob:${labels.get(blob)}`,
        readMeta: async (url) =>
            url === "blob:stale-original"
                ? { width: 4096, height: 4096, mimeType: "image/jpeg" }
                : { width: 320, height: 320, mimeType: "image/webp" },
    });

    const image = await operations.loadMediaThumbnail("strict-thumbnail", "https://oss.example/preview.webp", {
        preferRemoteThumbnail: true,
        maxThumbnailEdge: 512,
    });

    assert.equal(remoteFetches, 1);
    assert.equal(image.storageKey, imageThumbnailStorageKey("strict-thumbnail"));
    assert.equal(image.width, 320);
    assert.equal(await store.getItem(imageThumbnailStorageKey("strict-thumbnail")), compactPreview);
});

test("drops an oversized cached canvas thumbnail before decoding it", async () => {
    const store = new MemoryStore();
    const staleOriginal = new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: "image/jpeg" });
    const compactPreview = new Blob(["compact-preview"], { type: "image/webp" });
    await store.setItem(imageThumbnailStorageKey("oversized-thumbnail"), staleOriginal);
    let metaReads = 0;
    const { operations } = createTestOperations({
        store,
        fetchImageBlob: async () => compactPreview,
        readMeta: async () => {
            metaReads += 1;
            return { width: 320, height: 320, mimeType: "image/webp" };
        },
    });

    await operations.loadMediaThumbnail("oversized-thumbnail", "https://oss.example/preview.webp", {
        preferRemoteThumbnail: true,
        maxThumbnailEdge: 512,
    });

    assert.equal(metaReads, 1);
    assert.equal(await store.getItem(imageThumbnailStorageKey("oversized-thumbnail")), compactPreview);
});

test("re-signs exactly once when an original OSS request receives 403", async () => {
    let remoteAttempts = 0;
    let signedURLRequests = 0;
    const { operations } = createTestOperations({
        fetchImageBlob: async (url) => {
            remoteAttempts += 1;
            if (url.endsWith("Signature=AAA")) {
                const error = Object.assign(new Error("下载图片失败"), { status: 403 });
                throw error;
            }
            return new Blob(["fresh"], { type: "image/png" });
        },
    });

    const image = await operations.loadMediaImage("signed-media", async () => {
        signedURLRequests += 1;
        return signedURLRequests === 1 ? "https://oss.example/image?Signature=AAA" : "https://oss.example/image?Signature=BBB";
    });

    assert.equal(image.bytes, 5);
    assert.equal(remoteAttempts, 2);
    assert.equal(signedURLRequests, 2);
});

test("does not re-sign an original request for a non-403 failure", async () => {
    let remoteAttempts = 0;
    let signedURLRequests = 0;
    const { operations } = createTestOperations({
        fetchImageBlob: async () => {
            remoteAttempts += 1;
            throw Object.assign(new Error("下载图片失败"), { status: 404 });
        },
    });

    await assert.rejects(
        operations.loadMediaImage("missing-media", async () => {
            signedURLRequests += 1;
            return "https://oss.example/image?Signature=AAA";
        }),
        /下载图片失败/,
    );

    assert.equal(remoteAttempts, 1);
    assert.equal(signedURLRequests, 1);
});

test("aborting an original remote load leaves IndexedDB unchanged", async () => {
    const store = new MemoryStore();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const { operations } = createTestOperations({
        store,
        fetchImageBlob: async (_url, options) => {
            observedSignal = options?.signal;
            return new Promise<Blob>((_resolve, reject) => {
                options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
            });
        },
    });

    const pending = operations.loadMediaImage("abort-media", "https://oss.example/original.png", { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(observedSignal, controller.signal);
    assert.equal(await store.getItem(imageStorageKeyForMedia("abort-media")), null);
});

test("an aborted 403 request does not ask for a fresh signed URL", async () => {
    const controller = new AbortController();
    let accessRequests = 0;
    let fetches = 0;
    const { operations } = createTestOperations({
        fetchImageBlob: async () => {
            fetches += 1;
            controller.abort();
            throw Object.assign(new Error("expired"), { status: 403, name: "AbortError" });
        },
    });

    await assert.rejects(
        operations.loadMediaImage(
            "abort-403",
            () => {
                accessRequests += 1;
                return Promise.resolve(`https://oss.example/image?Signature=${accessRequests}`);
            },
            { signal: controller.signal },
        ),
        { name: "AbortError" },
    );
    assert.equal(fetches, 1);
    assert.equal(accessRequests, 1);
});

test("global LRU evicts inactive cache entries when the entry watermark is exceeded", async () => {
    let timestamp = 0;
    const store = new MemoryStore();
    const options = createTestOperations({
        store,
        now: () => ++timestamp,
        cacheBudgetBytes: 1024,
        cacheHighWatermarkBytes: 1024,
        cacheLowWatermarkBytes: 1024,
        cacheHighWatermarkEntries: 3,
        cacheLowWatermarkEntries: 1,
    });
    const operations = options.operations;

    const first = imageStorageKeyForMedia("entry-first");
    const second = imageStorageKeyForMedia("entry-second");
    const third = imageStorageKeyForMedia("entry-third");
    const fourth = imageStorageKeyForMedia("entry-fourth");
    await operations.storeImage(new Blob(["first"], { type: "image/png" }), first);
    await operations.storeImage(new Blob(["second"], { type: "image/png" }), second);
    await operations.storeImage(new Blob(["third"], { type: "image/png" }), third);
    await operations.storeImage(new Blob(["fourth"], { type: "image/png" }), fourth);
    operations.releaseObjectURL(first);
    operations.releaseObjectURL(second);
    operations.releaseObjectURL(third);
    operations.releaseObjectURL(fourth);

    await operations.enforceCacheBudget();

    assert.equal(await store.getItem(first), null);
    assert.equal(await store.getItem(second), null);
    assert.equal(await store.getItem(third), null);
    assert.ok(await store.getItem(fourth));
});

test("global cache budget evicts the oldest preview before inactive originals down to the low watermark", async () => {
    let timestamp = 0;
    const { operations, store } = createTestOperations({
        cacheBudgetBytes: 20,
        cacheHighWatermarkBytes: 12,
        cacheLowWatermarkBytes: 6,
        now: () => ++timestamp,
    });

    const oldOriginal = imageStorageKeyForMedia("old-original");
    const oldThumbnail = imageThumbnailStorageKey("old-thumbnail");
    const newOriginal = imageStorageKeyForMedia("new-original");
    await operations.storeImage(new Blob(["111111"], { type: "image/png" }), oldOriginal);
    await operations.setImageBlob(oldThumbnail, new Blob(["222222"], { type: "image/webp" }));
    await operations.storeImage(new Blob(["333333"], { type: "image/png" }), newOriginal);
    operations.releaseObjectURL(oldOriginal);
    operations.releaseObjectURL(oldThumbnail);

    const withBudget = operations as typeof operations & { enforceCacheBudget?: () => Promise<void> };
    assert.ok(withBudget.enforceCacheBudget, "缓存操作应提供全局预算回收");
    await withBudget.enforceCacheBudget?.();

    assert.equal(await store.getItem(oldThumbnail), null);
    assert.equal(await store.getItem(oldOriginal), null);
    assert.ok(await store.getItem(newOriginal));
});

test("global cache budget retains a blob while it has a visible Object URL", async () => {
    const { operations, store } = createTestOperations({ cacheBudgetBytes: 20, cacheHighWatermarkBytes: 12, cacheLowWatermarkBytes: 6 });

    const visible = imageStorageKeyForMedia("visible");
    const oldThumbnail = imageThumbnailStorageKey("old");
    const newest = imageStorageKeyForMedia("new");
    await operations.storeImage(new Blob(["visible"], { type: "image/png" }), visible);
    await operations.setImageBlob(oldThumbnail, new Blob(["oldest"], { type: "image/webp" }));
    await operations.setImageBlob(newest, new Blob(["newest"], { type: "image/png" }));
    operations.releaseObjectURL(oldThumbnail);
    operations.releaseObjectURL(newest);

    await operations.enforceCacheBudget();

    assert.ok(await store.getItem<Blob>(visible));
    assert.equal(await store.getItem<Blob>(oldThumbnail), null);
    assert.equal(await store.getItem<Blob>(newest), null);
});

test("loadMediaImage uses a cached original without fetching the remote URL", async () => {
    const store = new MemoryStore();
    await store.setItem(imageStorageKeyForMedia("media-1"), new Blob(["cached"], { type: "image/png" }));
    let remoteCalls = 0;
    const { operations } = createTestOperations({
        store,
        fetchImageBlob: async () => {
            remoteCalls += 1;
            return new Blob(["remote"], { type: "image/png" });
        },
    });

    const image = await operations.loadMediaImage("media-1", "https://oss.example/original.png");

    assert.equal(image.storageKey, imageStorageKeyForMedia("media-1"));
    assert.equal(remoteCalls, 0);
});

test("loadMediaThumbnail derives and stores a WebP thumbnail from the local original without a remote fetch", async () => {
    const store = new MemoryStore();
    const original = new Blob(["cached-original"], { type: "image/png" });
    const derived = new Blob(["derived-preview"], { type: "image/webp" });
    await store.setItem(imageStorageKeyForMedia("media-2"), original);
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

    const image = await operations.loadMediaThumbnail("media-2", "https://oss.example/thumbnail.webp");

    assert.equal(image.storageKey, imageThumbnailStorageKey("media-2"));
    assert.equal(derivedFrom, original);
    assert.equal(await store.getItem(imageThumbnailStorageKey("media-2")), derived);
    assert.equal(remoteCalls, 0);
});

test("thumbnail-first canvas loads prefer the OSS preview over decoding a cached original", async () => {
    const store = new MemoryStore();
    const original = new Blob(["cached-4k-original"], { type: "image/png" });
    const remotePreview = new Blob(["remote-preview"], { type: "image/webp" });
    await store.setItem(imageStorageKeyForMedia("media-preview-first"), original);
    let remoteCalls = 0;
    let previewConversions = 0;
    const { operations } = createTestOperations({
        store,
        createPreviewBlob: async () => {
            previewConversions += 1;
            return new Blob(["derived-preview"], { type: "image/webp" });
        },
        fetchImageBlob: async () => {
            remoteCalls += 1;
            return remotePreview;
        },
    });

    const image = await operations.loadMediaThumbnail("media-preview-first", "https://oss.example/thumbnail.webp", { preferRemoteThumbnail: true });

    assert.equal(image.storageKey, imageThumbnailStorageKey("media-preview-first"));
    assert.equal(await store.getItem(imageThumbnailStorageKey("media-preview-first")), remotePreview);
    assert.equal(remoteCalls, 1);
    assert.equal(previewConversions, 0);
});

test("loadMediaThumbnail falls back to the cached original when browser conversion fails", async () => {
    const store = new MemoryStore();
    const original = new Blob(["cached-original"], { type: "image/png" });
    await store.setItem(imageStorageKeyForMedia("media-3"), original);
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

    const image = await operations.loadMediaThumbnail("media-3", "https://oss.example/thumbnail.webp");

    assert.equal(image.storageKey, imageStorageKeyForMedia("media-3"));
    assert.equal(remoteCalls, 0);
});

test("cache hits do not create an access URL and cache misses create it only when downloading", async () => {
    const store = new MemoryStore();
    await store.setItem(imageStorageKeyForMedia("media-local"), new Blob(["cached-original"], { type: "image/png" }));
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
    assert.equal(await store.getItem(imageStorageKeyForMedia("media-stale")), null);
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
    await operations.deleteStoredImages([imageStorageKeyForMedia("delete-original")]);
    resolveRemote?.(new Blob(["late-original"], { type: "image/png" }));

    await assert.rejects(pending, /缓存已删除/);
    assert.equal(await store.getItem(imageStorageKeyForMedia("delete-original")), null);
    assert.equal(await store.getItem(imageThumbnailStorageKey("delete-original")), null);
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

    const pending = operations.loadMediaThumbnail("delete-preview", "https://oss.example/thumbnail.webp");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await operations.deleteStoredImages([imageStorageKeyForMedia("delete-preview")]);
    resolveRemote?.(new Blob(["late-preview"], { type: "image/webp" }));

    await assert.rejects(pending, /缓存已删除/);
    assert.equal(await store.getItem(imageThumbnailStorageKey("delete-preview")), null);
});

test("an invalidated partial write cannot erase a newer generation written after deletion", async () => {
    const store = new MemoryStore();
    const writeStoredItem = store.setItem.bind(store);
    let firstWriteStarted: (() => void) | undefined;
    let releaseFirstWrite: (() => void) | undefined;
    let mediaWrites = 0;
    store.setItem = async <T>(key: string, value: T) => {
        if (key === imageStorageKeyForMedia("replace-after-delete")) {
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
    const deletion = operations.deleteStoredImages([imageStorageKeyForMedia("replace-after-delete")]);
    const newLoad = operations.loadMediaImage("replace-after-delete", "https://oss.example/new.png");
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirstWrite?.();

    await deletion;
    await assert.rejects(oldLoad, /缓存已删除/);
    await newLoad;
    const stored = await store.getItem<Blob>(imageStorageKeyForMedia("replace-after-delete"));
    assert.equal(await stored?.text(), "new");
});

test("an old A context cannot overwrite a newer A context after A → B → A", async () => {
    const store = new MemoryStore();
    const writeStoredItem = store.setItem.bind(store);
    const oldWriteStarted = deferred<void>();
    const releaseOldWrite = deferred<void>();
    store.setItem = async <T>(key: string, value: T) => {
        if (key === imageStorageKeyForMedia("return-to-a") && value instanceof Blob && (await value.text()) === "old") {
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
    const stored = await store.getItem<Blob>(imageStorageKeyForMedia("return-to-a"));
    assert.equal(await stored?.text(), "new");
});

test("deleting a temporary source while promote is writing never creates the target media", async () => {
    const store = new MemoryStore();
    const sourceKey = "image:temporary-source";
    const targetKey = imageStorageKeyForMedia("promoted-after-delete");
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
    const storageKey = imageStorageKeyForMedia("set-in-progress");
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
    const targetKey = imageStorageKeyForMedia("promote-in-progress");
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

test("generic cleanup retains thumbnails, explicit media deletion removes both variants", async () => {
    const store = new MemoryStore();
    const originalKey = imageStorageKeyForMedia("unused");
    const thumbnailKey = imageThumbnailStorageKey("unused");
    await store.setItem(originalKey, new Blob(["original"]));
    await store.setItem(thumbnailKey, new Blob(["thumbnail"]));
    const { operations } = createTestOperations({ store });

    await operations.cleanupUnusedImages({});
    assert.equal(await store.getItem(originalKey), null);
    assert.ok(await store.getItem(thumbnailKey));

    await operations.deleteStoredImages([originalKey]);
    assert.equal(await store.getItem(thumbnailKey), null);
});

test("an Object URL hit updates global LRU metadata without blocking display", async () => {
    const store = new MemoryStore();
    const key = imageThumbnailStorageKey("memory-hit");
    await store.setItem(key, new Blob(["thumbnail"], { type: "image/webp" }));
    await store.setItem(`cache-meta:${key}`, { bytes: 9, cachedAt: 1, lastAccessedAt: 1, variant: "thumbnail" });
    const writeStoredItem = store.setItem.bind(store);
    let releaseMetadataWrite: (() => void) | undefined;
    store.setItem = async <T>(storedKey: string, value: T) => {
        if (storedKey === `cache-meta:${key}`) {
            await new Promise<void>((resolve) => {
                releaseMetadataWrite = resolve;
            });
        }
        return writeStoredItem(storedKey, value);
    };
    const { operations } = createTestOperations({ store, objectUrls: new Map([[key, "blob:cached-thumbnail"]]), now: () => 999 });

    const result = await Promise.race([operations.resolveImageUrl(key), new Promise<string>((_, reject) => setTimeout(() => reject(new Error("图片显示被元数据写入阻塞")), 20))]);
    assert.equal(result, "blob:cached-thumbnail");

    for (let attempt = 0; attempt < 5 && !releaseMetadataWrite; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(releaseMetadataWrite);
    releaseMetadataWrite?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(await store.getItem(`cache-meta:${key}`), { bytes: 9, cachedAt: 1, lastAccessedAt: 999, variant: "thumbnail" });
});

test("generic cleanup does not delete a media key while its remote load is in flight", async () => {
    const store = new MemoryStore();
    const key = imageStorageKeyForMedia("loading");
    await store.setItem(key, new Blob(["stale"], { type: "image/png" }));
    const readStoredItem = store.getItem.bind(store);
    let simulatedCacheMisses = 2;
    store.getItem = async <T>(key: string) => {
        if (key === imageStorageKeyForMedia("loading") && simulatedCacheMisses > 0) {
            simulatedCacheMisses -= 1;
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
    assert.ok(await store.getItem(key));
    resolveRemote?.(new Blob(["remote"], { type: "image/png" }));
    const image = await pending;

    assert.equal(image.storageKey, key);
    assert.ok(await store.getItem(key));
});

test("cleanup keeps an original protected until every overlapping original and preview load finishes", async () => {
    const store = new MemoryStore();
    const readStoredItem = store.getItem.bind(store);
    let mediaMissesRemaining = 2;
    store.getItem = async <T>(key: string) => {
        if (key === imageStorageKeyForMedia("shared-reference") && mediaMissesRemaining > 0) {
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
    const preview = operations.loadMediaThumbnail("shared-reference", "https://oss.example/thumbnail.webp");
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolvers.get("https://oss.example/original.png")?.(new Blob(["original"], { type: "image/png" }));
    await original;

    await operations.cleanupUnusedImages({});
    assert.ok(await store.getItem(imageStorageKeyForMedia("shared-reference")));

    resolvers.get("https://oss.example/thumbnail.webp")?.(new Blob(["thumbnail"], { type: "image/webp" }));
    await preview;
});

test("replacing a cached object URL revokes the obsolete URL once", async () => {
    const { operations, revoked } = createTestOperations({});

    const first = await operations.setImageBlob("media:replace", new Blob(["first"]));
    const second = await operations.setImageBlob("media:replace", new Blob(["second"]));

    assert.notEqual(first, second);
    assert.deepEqual(revoked, [first]);
});

test("releasing a visible image revokes only its in-memory object URL and preserves the IndexedDB blob", async () => {
    const store = new MemoryStore();
    const { operations, revoked } = createTestOperations({ store });
    const objectURL = await operations.setImageBlob("preview:visible", new Blob(["preview"], { type: "image/webp" }));

    const withRelease = operations as typeof operations & { releaseObjectURL?: (storageKey: string) => void };
    assert.ok(withRelease.releaseObjectURL, "缓存操作应支持释放不可见图片的 Blob URL");
    withRelease.releaseObjectURL?.("preview:visible");

    assert.deepEqual(revoked, [objectURL]);
    assert.ok(await store.getItem("preview:visible"));
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
    const key = imageStorageKeyForMedia("already-stable");
    await store.setItem(key, blob);
    const { operations } = createTestOperations({
        store,
        objectUrls: new Map([[key, "blob:already-stable"]]),
    });

    const promoted = await operations.promoteImageStorageKey(
        {
            url: "blob:already-stable",
            storageKey: key,
            width: 640,
            height: 480,
            bytes: blob.size,
            mimeType: blob.type,
            mediaId: "already-stable",
        },
        "already-stable",
    );

    assert.equal(promoted.storageKey, key);
    assert.equal(await store.getItem(key), blob);
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
