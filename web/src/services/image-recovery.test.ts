import assert from "node:assert/strict";
import test from "node:test";

import { recoverPersistedImage } from "./image-recovery.ts";

test("uses the IndexedDB image without requesting the media service", async () => {
    let remoteRequests = 0;

    const result = await recoverPersistedImage(
        { content: "blob:expired", storageKey: "image:cached", mediaId: "media-1" },
        {
            readCachedImage: async () => "blob:cached",
            downloadMediaImage: async () => {
                remoteRequests += 1;
                return { content: "blob:remote", storageKey: "image:remote" };
            },
        },
    );

    assert.deepEqual(result, { status: "cached", content: "blob:cached" });
    assert.equal(remoteRequests, 0);
});

test("downloads and caches a media image when the IndexedDB entry is missing", async () => {
    let requestedMediaId = "";

    const result = await recoverPersistedImage(
        { content: "blob:expired", storageKey: "image:missing", mediaId: "media-2" },
        {
            readCachedImage: async () => "",
            downloadMediaImage: async (mediaId) => {
                requestedMediaId = mediaId;
                return { content: "blob:restored", storageKey: "image:restored", mediaId };
            },
        },
    );

    assert.deepEqual(result, { status: "remote", content: "blob:restored", storageKey: "image:restored", mediaId: "media-2" });
    assert.equal(requestedMediaId, "media-2");
});

test("recovers a node with an expired Blob URL even when it has no local storage key", async () => {
    const result = await recoverPersistedImage(
        { content: "blob:expired", mediaId: "media-3" },
        {
            readCachedImage: async () => {
                throw new Error("should not read cache without a key");
            },
            downloadMediaImage: async () => ({ content: "blob:restored", storageKey: "image:restored" }),
        },
    );

    assert.deepEqual(result, { status: "remote", content: "blob:restored", storageKey: "image:restored" });
});

test("returns a node-level recovery error instead of rejecting the whole restore", async () => {
    const result = await recoverPersistedImage(
        { mediaId: "media-4" },
        {
            readCachedImage: async () => "",
            downloadMediaImage: async () => {
                throw new Error("图片不存在或无权访问");
            },
        },
    );

    assert.deepEqual(result, { status: "error", error: "图片不存在或无权访问" });
});
