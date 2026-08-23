import assert from "node:assert/strict";
import test from "node:test";

import { CanvasNodeType, type CanvasNodeData } from "../app/(user)/canvas/types";
import { hydrateCanvasImages, type CanvasImageMetadata } from "./canvas-image-hydration.ts";

type Equal<Actual, Expected> = (<Value>() => Value extends Actual ? 1 : 2) extends <Value>() => Value extends Expected ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;
type HydratedStatus = NonNullable<Awaited<ReturnType<typeof hydrateCanvasImages>>[number]["metadata"]>["status"];
type HydratedStatusCanChange = Assert<Equal<HydratedStatus, CanvasImageMetadata["status"]>>;
type HydratedPrompt = NonNullable<Awaited<ReturnType<typeof hydrateCanvasImages>>[number]["metadata"]>["prompt"];
type HydratedPromptIsPreserved = Assert<Equal<HydratedPrompt, string | undefined>>;

type CanvasNodeFixture = CanvasNodeData;

const imageNode = (metadata: CanvasNodeFixture["metadata"]): CanvasNodeFixture => ({
    id: "image-node",
        type: CanvasNodeType.Image,
    title: "Image",
    position: { x: 0, y: 0 },
    width: 320,
    height: 240,
    metadata,
});

const videoNode = (metadata: CanvasNodeFixture["metadata"]): CanvasNodeFixture => ({
    id: "video-node",
        type: CanvasNodeType.Video,
    title: "Video",
    position: { x: 0, y: 0 },
    width: 320,
    height: 240,
    metadata,
});

test("hydrates cached images and clears stale recovery errors", async () => {
    const [restored] = await hydrateCanvasImages([imageNode({ content: "blob:expired", storageKey: "media:cached", mediaId: "media-1", status: "error", errorDetails: "旧错误" })], {
        resolveMediaUrl: async () => "",
        readCachedImage: async () => "blob:cached",
        resolveRemoteImage: async () => {
            throw new Error("缓存命中时不应请求远端媒体");
        },
        fetchPublicImageAccess: async () => {
            throw new Error("缓存命中时不应请求公共图片");
        },
        loadMediaImage: async () => {
            throw new Error("缓存命中时不应加载媒体");
        },
        uploadImage: async () => {
            throw new Error("缓存命中时不应上传图片");
        },
    });

    assert.deepEqual(restored.metadata, {
        content: "blob:cached",
        storageKey: "media:cached",
        mediaId: "media-1",
        status: "success",
        errorDetails: undefined,
    });
});

test("uses public image access when restoring a missing cached public image", async () => {
    const [restored] = await hydrateCanvasImages([imageNode({ content: "blob:expired", storageKey: "media:missing", mediaId: "media-2", publicImageId: "public-2" })], {
        resolveMediaUrl: async () => "",
        readCachedImage: async () => "",
        resolveRemoteImage: async () => {
            throw new Error("公共图片不应使用私有媒体地址");
        },
        fetchPublicImageAccess: async (publicImageId) => {
            assert.equal(publicImageId, "public-2");
            return { url: "https://public.example/image" };
        },
        loadMediaImage: async (mediaId, remoteURL) => {
            const source = await remoteURL();
            assert.equal(source, "https://public.example/image");
            assert.equal(mediaId, "media-2");
            return { url: "blob:public", storageKey: "media:2", mediaId, width: 1200, height: 800, bytes: 2048, mimeType: "image/webp" };
        },
        uploadImage: async () => {
            throw new Error("远端恢复不应使用直接上传");
        },
    });

    assert.deepEqual(restored.metadata, {
        content: "blob:public",
        storageKey: "media:2",
        mediaId: "media-2",
        publicImageId: "public-2",
        naturalWidth: 1200,
        naturalHeight: 800,
        bytes: 2048,
        mimeType: "image/webp",
        status: "success",
        errorDetails: undefined,
    });
});

test("maps remote recovery failures to one image node without rejecting the batch", async () => {
    const [failed, text] = await hydrateCanvasImages([imageNode({ content: "blob:expired", mediaId: "media-3" }), { ...imageNode({ content: "unchanged" }), id: "text-node", type: CanvasNodeType.Text }], {
        resolveMediaUrl: async () => "",
        readCachedImage: async () => "",
        resolveRemoteImage: async () => {
            throw new Error("媒体不存在或无权访问");
        },
        fetchPublicImageAccess: async () => {
            throw new Error("不是公共图片");
        },
        loadMediaImage: async (_mediaId, remoteURL) => {
            await remoteURL();
            throw new Error("远端地址不可用");
        },
        uploadImage: async () => {
            throw new Error("远端地址不可用");
        },
    });

    assert.deepEqual(failed.metadata, { content: "blob:expired", mediaId: "media-3", status: "error", errorDetails: "恢复图片失败：媒体不存在或无权访问" });
    assert.deepEqual(text.metadata, { content: "unchanged" });
});

test("restores video storage keys without running image recovery", async () => {
    const [restored] = await hydrateCanvasImages([videoNode({ content: "blob:expired-video", storageKey: "video:1", status: "success" })], {
        resolveMediaUrl: async (storageKey, fallback) => {
            assert.equal(storageKey, "video:1");
            assert.equal(fallback, "blob:expired-video");
            return "blob:restored-video";
        },
        readCachedImage: async () => {
            throw new Error("视频不应读取图片缓存");
        },
        resolveRemoteImage: async () => {
            throw new Error("视频不应读取远端图片");
        },
        fetchPublicImageAccess: async () => {
            throw new Error("视频不应读取公共图片");
        },
        loadMediaImage: async () => {
            throw new Error("视频不应加载图片");
        },
        uploadImage: async () => {
            throw new Error("视频不应上传图片");
        },
    });

    assert.deepEqual(restored.metadata, { content: "blob:restored-video", storageKey: "video:1", status: "success" });
});

test("keeps other nodes restored when a data URL persistence fallback fails", async () => {
    const [failed, cached] = await hydrateCanvasImages([imageNode({ content: "data:image/png;base64,broken" }), { ...imageNode({ content: "blob:expired", storageKey: "image:cached" }), id: "cached-node" }], {
        resolveMediaUrl: async () => "",
        readCachedImage: async (storageKey) => (storageKey === "image:cached" ? "blob:cached" : ""),
        resolveRemoteImage: async () => {
            throw new Error("没有媒体记录时不应请求远端图片");
        },
        fetchPublicImageAccess: async () => {
            throw new Error("没有公共图片记录时不应请求公共图片");
        },
        loadMediaImage: async () => {
            throw new Error("没有媒体记录时不应加载图片");
        },
        uploadImage: async () => {
            throw new Error("持久化失败");
        },
    });

    assert.deepEqual(failed.metadata, { content: "data:image/png;base64,broken", status: "error", errorDetails: "恢复图片失败：持久化失败" });
    assert.deepEqual(cached.metadata, { content: "blob:cached", storageKey: "image:cached", status: "success", errorDetails: undefined });
});

test("persists data URL images and replaces stale metadata", async () => {
    const [restored] = await hydrateCanvasImages([imageNode({ content: "data:image/png;base64,source", status: "error", errorDetails: "旧错误" })], {
        resolveMediaUrl: async () => "",
        readCachedImage: async () => "",
        resolveRemoteImage: async () => {
            throw new Error("没有媒体记录时不应请求远端图片");
        },
        fetchPublicImageAccess: async () => {
            throw new Error("没有公共图片记录时不应请求公共图片");
        },
        loadMediaImage: async () => {
            throw new Error("没有媒体记录时不应加载图片");
        },
        uploadImage: async (source, mediaId) => {
            assert.equal(source, "data:image/png;base64,source");
            assert.equal(mediaId, undefined);
            return { url: "blob:persisted", storageKey: "image:persisted", width: 1024, height: 768, bytes: 4096, mimeType: "image/png" };
        },
    });

    assert.deepEqual(restored.metadata, {
        content: "blob:persisted",
        storageKey: "image:persisted",
        mediaId: undefined,
        naturalWidth: 1024,
        naturalHeight: 768,
        bytes: 4096,
        mimeType: "image/png",
        status: "success",
        errorDetails: undefined,
    });
});
