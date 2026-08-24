import assert from "node:assert/strict";
import test from "node:test";

import { hydrateStoredAssets } from "./asset-storage-hydration.ts";

test("keeps a persisted private image metadata-only when the local cache is absent", async () => {
    let remoteLoads = 0;
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
            resolveRemoteImage: async () => "https://media.example/image",
            loadMediaImage: async (mediaId, remoteURL) => {
                remoteLoads += 1;
                assert.equal(mediaId, "media-1");
                await remoteURL();
                return { url: "blob:should-not-load", storageKey: "media:media-1", width: 1200, height: 800, bytes: 2048, mimeType: "image/webp" };
            },
            uploadImage: async () => {
                throw new Error("远端恢复不应使用直接上传");
            },
        },
    );

    assert.deepEqual(asset, {
        id: "asset-1",
        kind: "image",
        coverUrl: "blob:expired",
        data: { dataUrl: "blob:expired", storageKey: "media:media-1", width: 1, height: 1, bytes: 1, mimeType: "image/png" },
        metadata: { mediaId: "media-1" },
    });
    assert.equal(remoteLoads, 0);
});

test("keeps persisted remote assets metadata-only during startup hydration", async () => {
    let remoteLoads = 0;
    const [asset] = await hydrateStoredAssets(
        [
            {
                id: "asset-metadata-only",
                kind: "image",
                coverUrl: "blob:expired",
                data: { dataUrl: "blob:expired", storageKey: "media:media-metadata-only", width: 1200, height: 800, bytes: 2048, mimeType: "image/png" },
                metadata: { mediaId: "media-metadata-only", uploadState: "uploaded" },
            },
        ],
        {
            resolveImageUrl: async () => "",
            resolveRemoteImage: async () => "https://media.example/image",
            loadMediaImage: async () => {
                remoteLoads += 1;
                return { url: "blob:should-not-load", storageKey: "media:media-metadata-only", width: 1200, height: 800, bytes: 2048, mimeType: "image/png" };
            },
            uploadImage: async () => {
                throw new Error("远端已保存素材不应在启动时转换为本地图片");
            },
        },
    );

    assert.equal(remoteLoads, 0);
    assert.equal(asset.coverUrl, "blob:expired");
    assert.equal(asset.data.dataUrl, "blob:expired");
});

test("keeps a persisted public image metadata-only when the local cache is absent", async () => {
    let remoteLoads = 0;
    const [asset] = await hydrateStoredAssets(
        [
            {
                id: "public-asset-1",
                kind: "image",
                coverUrl: "blob:expired",
                data: { dataUrl: "blob:expired", storageKey: "media:media-public-1", width: 1, height: 1, bytes: 1, mimeType: "image/png" },
                metadata: { mediaId: "media-public-1", publicImageId: "public-1" },
            },
        ],
        {
            resolveImageUrl: async () => "",
            resolveRemoteImage: async () => "https://media.example/image",
            resolvePublicImage: async () => "https://public.example/image",
            loadMediaImage: async (mediaId, remoteURL) => {
                remoteLoads += 1;
                assert.equal(mediaId, "media-public-1");
                await remoteURL();
                return { url: "blob:should-not-load", storageKey: "media:media-public-1", width: 1200, height: 800, bytes: 2048, mimeType: "image/webp" };
            },
            uploadImage: async () => {
                throw new Error("远端恢复不应使用直接上传");
            },
        },
    );

    assert.equal(asset.coverUrl, "blob:expired");
    assert.equal(asset.data.dataUrl, "blob:expired");
    assert.deepEqual(asset.metadata, { mediaId: "media-public-1", publicImageId: "public-1" });
    assert.equal(remoteLoads, 0);
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
            loadMediaImage: async (_mediaId, remoteURL) => {
                await remoteURL();
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

test("restores a pending private upload from its local storage key without requesting remote media", async () => {
    const [asset] = await hydrateStoredAssets(
        [
            {
                id: "pending-local",
                kind: "image",
                coverUrl: "blob:expired",
                data: { dataUrl: "blob:expired", storageKey: "image:pending-local", width: 640, height: 480, bytes: 1024, mimeType: "image/png" },
                metadata: { uploadState: "pending" },
            },
        ],
        {
            resolveImageUrl: async (storageKey) => {
                assert.equal(storageKey, "image:pending-local");
                return "blob:restored-pending";
            },
            resolveRemoteImage: async () => {
                throw new Error("本地待上传素材不应请求远端媒体");
            },
            loadMediaImage: async () => {
                throw new Error("本地待上传素材不应加载远端媒体");
            },
            uploadImage: async () => {
                throw new Error("本地待上传素材不应重新上传");
            },
        },
    );

    assert.equal(asset.coverUrl, "blob:restored-pending");
    assert.equal(asset.data.dataUrl, "blob:restored-pending");
    assert.equal(asset.data.storageKey, "image:pending-local");
});
