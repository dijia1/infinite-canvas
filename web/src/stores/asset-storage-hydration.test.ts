import assert from "node:assert/strict";
import test from "node:test";

import { hydrateStoredAssets } from "./asset-storage-hydration.ts";

test("recovers a persisted private image from its media ID when the local cache is absent", async () => {
    const [asset] = await hydrateStoredAssets(
        [
            {
                id: "asset-1",
                kind: "image",
                coverUrl: "blob:expired",
                data: { dataUrl: "blob:expired", storageKey: "media:media-1", width: 1, height: 1, bytes: 1, mimeType: "image/png" },
                metadata: { mediaId: "media-1" },
            },
        ],
        {
            resolveImageUrl: async () => "",
            resolveRemoteImage: async (mediaId) => {
                assert.equal(mediaId, "media-1");
                return "https://media.example/image";
            },
            uploadImage: async (source, mediaId) => {
                assert.equal(source, "https://media.example/image");
                assert.equal(mediaId, "media-1");
                return { url: "blob:restored", storageKey: "media:media-1", width: 1200, height: 800, bytes: 2048, mimeType: "image/webp" };
            },
        },
    );

    assert.deepEqual(asset, {
        id: "asset-1",
        kind: "image",
        coverUrl: "blob:restored",
        data: { dataUrl: "blob:restored", storageKey: "media:media-1", width: 1200, height: 800, bytes: 2048, mimeType: "image/webp" },
        metadata: { mediaId: "media-1" },
    });
});

test("keeps other persisted assets when one image cannot be recovered", async () => {
    const assets = await hydrateStoredAssets(
        [
            { id: "broken", kind: "image", coverUrl: "blob:expired", data: { dataUrl: "blob:expired", storageKey: "media:missing" }, metadata: { mediaId: "missing" } },
            { id: "text", kind: "text", data: { content: "保留我" } },
        ],
        {
            resolveImageUrl: async () => "",
            resolveRemoteImage: async () => {
                throw new Error("not found");
            },
            uploadImage: async () => {
                throw new Error("should not upload");
            },
        },
    );

    assert.equal(assets.length, 2);
    assert.equal(assets[1]?.id, "text");
    assert.equal(assets[0]?.id, "broken");
});
