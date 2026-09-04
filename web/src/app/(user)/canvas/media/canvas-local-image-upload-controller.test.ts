import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasLocalImageUploadController } from "./canvas-local-image-upload-controller.ts";

const file = new File(["local image"], "local.png", { type: "image/png" });
const localImage = { url: "blob:local", storageKey: "image:local", width: 640, height: 480, bytes: file.size, mimeType: "image/png" };

test("promotes an immediately displayed local image after its background upload completes", async () => {
    const events: string[] = [];
    const controller = createCanvasLocalImageUploadController({
        upload: async (_file, _intent, options) => {
            options.onProgress?.(42);
            options.onProgress?.(100);
            return { mediaId: "media-1", url: "https://oss.example/original", mediaExpiresAt: "2026-09-04T01:00:00Z" };
        },
        promote: async (image, mediaId) => ({ ...image, storageKey: `media:${mediaId}:v1:original`, mediaId }),
        onProgress: (_nodeId, progress) => events.push(`progress:${progress}`),
        onCompleted: (_nodeId, image, remote) => events.push(`completed:${image.mediaId}:${remote.mediaExpiresAt}`),
        onFailed: (_nodeId, error) => events.push(`failed:${error}`),
    });

    await controller.start({ nodeId: "node-1", file, image: localImage, intent: "library" });

    assert.deepEqual(events, ["progress:42", "progress:100", "completed:media-1:2026-09-04T01:00:00Z"]);
    assert.equal(controller.isActive("node-1"), false);
});

test("keeps the local node retryable when its background upload fails", async () => {
    const failures: string[] = [];
    const controller = createCanvasLocalImageUploadController({
        upload: async () => {
            throw new Error("OSS 暂不可用");
        },
        promote: async (image) => image,
        onProgress: () => undefined,
        onCompleted: () => undefined,
        onFailed: (_nodeId, error) => failures.push(error),
    });

    await controller.start({ nodeId: "node-1", file, image: localImage, intent: "library" });

    assert.deepEqual(failures, ["OSS 暂不可用"]);
    assert.equal(controller.isActive("node-1"), false);
});

test("does not mark a deleted local node as failed after its upload is cancelled", async () => {
    let rejectUpload: ((error: Error) => void) | undefined;
    const failures: string[] = [];
    const controller = createCanvasLocalImageUploadController({
        upload: async (_file, _intent, options) =>
            await new Promise((_, reject) => {
                rejectUpload = reject;
                options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("上传已取消"), { name: "AbortError" })));
            }),
        promote: async (image) => image,
        onProgress: () => undefined,
        onCompleted: () => undefined,
        onFailed: (_nodeId, error) => failures.push(error),
    });

    const task = controller.start({ nodeId: "node-1", file, image: localImage, intent: "library" });
    controller.cancel("node-1");
    rejectUpload?.(Object.assign(new Error("上传已取消"), { name: "AbortError" }));
    await task;

    assert.deepEqual(failures, []);
    assert.equal(controller.isActive("node-1"), false);
});

test("treats an aborted upload request as cancellation even when its client reports a generic error", async () => {
    let rejectUpload: ((error: Error) => void) | undefined;
    const failures: string[] = [];
    const controller = createCanvasLocalImageUploadController({
        upload: async () =>
            await new Promise((_, reject) => {
                rejectUpload = reject;
            }),
        promote: async (image) => image,
        onProgress: () => undefined,
        onCompleted: () => undefined,
        onFailed: (_nodeId, error) => failures.push(error),
    });

    const task = controller.start({ nodeId: "node-1", file, image: localImage, intent: "library" });
    controller.cancel("node-1");
    rejectUpload?.(new Error("request cancelled"));
    await task;

    assert.deepEqual(failures, []);
    assert.equal(controller.isActive("node-1"), false);
});
