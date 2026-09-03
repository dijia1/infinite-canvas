import assert from "node:assert/strict";
import test from "node:test";

import type { UploadedImage } from "@/services/image-storage";
import { createCanvasImageResourceController, type CanvasImageResourceRequest } from "./canvas-image-resource-controller.ts";
import { createCanvasMediaLoadQueue } from "./canvas-media-load-queue.ts";

function image(variant: "thumbnail" | "original"): UploadedImage {
    return {
        url: `blob:${variant}`,
        storageKey: `media:one:v1:${variant}`,
        mediaId: "one",
        width: variant === "thumbnail" ? 320 : 4096,
        height: variant === "thumbnail" ? 320 : 4096,
        bytes: variant === "thumbnail" ? 10 : 100,
        mimeType: variant === "thumbnail" ? "image/webp" : "image/png",
    };
}

function deferred<Value>() {
    let resolve: (value: Value) => void = () => undefined;
    const promise = new Promise<Value>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}

function request(
    variant: "thumbnail" | "original",
    loaders: { thumbnail: (signal: AbortSignal) => Promise<UploadedImage>; original: (signal: AbortSignal) => Promise<UploadedImage> },
    options: Pick<CanvasImageResourceRequest, "releaseOriginalAfterThumbnail"> = {},
): CanvasImageResourceRequest {
    return {
        nodeId: "node-1",
        mediaId: "one",
        variant,
        priority: variant === "original" ? "interactive" : "visible-thumbnail",
        ...options,
        loadThumbnail: loaders.thumbnail,
        loadOriginal: loaders.original,
    };
}

test("keeps the thumbnail lease until the promoted original is rendered", async () => {
    const released: string[] = [];
    const original = deferred<UploadedImage>();
    const controller = createCanvasImageResourceController({
        queue: createCanvasMediaLoadQueue({ concurrency: 1 }),
        releaseObjectURL: (storageKey) => released.push(storageKey),
        deferRelease: (release) => release(),
    });
    const loaders = {
        thumbnail: async () => image("thumbnail"),
        original: async () => original.promise,
    };

    controller.reconcile([request("thumbnail", loaders)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(controller.get("node-1")?.variant, "thumbnail");

    controller.reconcile([request("original", loaders)]);
    assert.equal(controller.get("node-1")?.url, "blob:thumbnail");
    original.resolve(image("original"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(controller.get("node-1")?.variant, "original");
    assert.deepEqual(released, []);
    controller.acknowledgeRendered("node-1", "media:one:v1:original");
    assert.deepEqual(released, ["media:one:v1:thumbnail"]);
});

test("releases an upload-created original URL after a non-selected node has rendered its thumbnail", async () => {
    const released: string[] = [];
    const controller = createCanvasImageResourceController({
        queue: createCanvasMediaLoadQueue({ concurrency: 1 }),
        releaseObjectURL: (storageKey) => released.push(storageKey),
        deferRelease: (release) => release(),
    });

    controller.reconcile([
        request(
            "thumbnail",
            {
                thumbnail: async () => image("thumbnail"),
                original: async () => image("original"),
            },
            { releaseOriginalAfterThumbnail: true },
        ),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(released, ["media:one:v1:original"]);
});

test("drops a stale completion after a node is no longer needed", async () => {
    const released: string[] = [];
    const original = deferred<UploadedImage>();
    const controller = createCanvasImageResourceController({
        queue: createCanvasMediaLoadQueue({ concurrency: 1 }),
        releaseObjectURL: (storageKey) => released.push(storageKey),
        deferRelease: (release) => release(),
    });

    controller.reconcile([
        request("original", {
            thumbnail: async () => image("thumbnail"),
            original: async () => original.promise,
        }),
    ]);
    controller.reconcile([]);
    original.resolve(image("original"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(controller.get("node-1"), undefined);
    assert.deepEqual(released, ["media:one:v1:original"]);
});

test("does not release a shared Object URL until every canvas node stops using it", async () => {
    const released: string[] = [];
    const controller = createCanvasImageResourceController({
        queue: createCanvasMediaLoadQueue({ concurrency: 2 }),
        releaseObjectURL: (storageKey) => released.push(storageKey),
        deferRelease: (release) => release(),
    });
    const shared = { ...image("thumbnail"), url: "blob:shared" };
    const second: CanvasImageResourceRequest = {
        ...request("thumbnail", { thumbnail: async () => shared, original: async () => image("original") }),
        nodeId: "node-2",
    };
    const first = request("thumbnail", { thumbnail: async () => shared, original: async () => image("original") });

    controller.reconcile([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.reconcile([second]);
    assert.deepEqual(released, []);
    controller.reconcile([]);
    assert.deepEqual(released, ["media:one:v1:thumbnail"]);
});
