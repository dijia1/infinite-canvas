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
            loadMediaImage: async (mediaId, remoteURL) => {
                const source = await remoteURL();
                assert.equal(source, "https://media.example/image");
                assert.equal(mediaId, "media-1");
                return { url: "blob:restored", storageKey: "media:media-1", width: 1200, height: 800, bytes: 2048, mimeType: "image/webp" };
            },
            uploadImage: async () => {
                throw new Error("远端恢复不应使用直接上传");
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

test("recovers a persisted public image through its public image ID when the local cache is absent", async () => {
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
            resolveRemoteImage: async () => {
                throw new Error("公共图片不应使用私人媒体访问接口");
            },
            resolvePublicImage: async (publicImageId) => {
                assert.equal(publicImageId, "public-1");
                return "https://public.example/image";
            },
            loadMediaImage: async (mediaId, remoteURL) => {
                const source = await remoteURL();
                assert.equal(source, "https://public.example/image");
                assert.equal(mediaId, "media-public-1");
                return { url: "blob:public-restored", storageKey: "media:media-public-1", width: 1200, height: 800, bytes: 2048, mimeType: "image/webp" };
            },
            uploadImage: async () => {
                throw new Error("远端恢复不应使用直接上传");
            },
        },
    );

    assert.equal(asset.coverUrl, "blob:public-restored");
    assert.equal(asset.data.dataUrl, "blob:public-restored");
    assert.deepEqual(asset.metadata, { mediaId: "media-public-1", publicImageId: "public-1" });
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
