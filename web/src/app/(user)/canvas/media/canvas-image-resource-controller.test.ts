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

test("keeps a completed original when an aborted thumbnail ignores cancellation and finishes late", async () => {
    const released: string[] = [];
    const thumbnail = deferred<UploadedImage>();
    const original = deferred<UploadedImage>();
    const thumbnailStarted = deferred<void>();
    const originalStarted = deferred<void>();
    const originalRendered = deferred<void>();
    const thumbnailReleased = deferred<void>();
    let thumbnailSignal: AbortSignal | undefined;
    let originalLoads = 0;
    const queue = createCanvasMediaLoadQueue({ concurrency: 2 });
    const controller = createCanvasImageResourceController({
        queue,
        releaseObjectURL: (storageKey) => {
            released.push(storageKey);
            if (storageKey === image("thumbnail").storageKey) thumbnailReleased.resolve();
        },
        deferRelease: (release) => release(),
        onChange: () => originalRendered.resolve(),
    });
    const loaders = {
        thumbnail: async (signal: AbortSignal) => {
            thumbnailSignal = signal;
            thumbnailStarted.resolve();
            return thumbnail.promise;
        },
        original: async () => {
            originalLoads += 1;
            originalStarted.resolve();
            return original.promise;
        },
    };

    controller.reconcile([request("thumbnail", loaders)]);
    await thumbnailStarted.promise;
    controller.reconcile([request("original", loaders)]);
    await originalStarted.promise;
    assert.equal(thumbnailSignal?.aborted, true);

    original.resolve(image("original"));
    await originalRendered.promise;
    assert.equal(controller.get("node-1")?.variant, "original");
    assert.equal(controller.get("node-1")?.url, "blob:original");

    thumbnail.resolve(image("thumbnail"));
    await thumbnailReleased.promise;
    assert.equal(controller.get("node-1")?.variant, "original");
    assert.equal(controller.get("node-1")?.url, "blob:original");
    assert.equal(controller.errors().size, 0);
    assert.equal(originalLoads, 1);
    assert.deepEqual(released, ["media:one:v1:thumbnail"]);

    const probes = [0, 1].map((index) =>
        queue.request({ key: `probe:${index}`, priority: "interactive", load: async () => index }),
    );
    assert.deepEqual(await Promise.all(probes.map((probe) => probe.promise)), [0, 1]);
    assert.equal(controller.get("node-1")?.url, "blob:original");
    controller.dispose();
});

test("does not release a late thumbnail while another node still owns the shared resource", async () => {
    const released: string[] = [];
    const deferredReleases: Array<() => void> = [];
    const thumbnail = deferred<UploadedImage>();
    const original = deferred<UploadedImage>();
    const thumbnailStarted = deferred<void>();
    const originalStarted = deferred<void>();
    let changed = deferred<void>();
    let thumbnailSignal: AbortSignal | undefined;
    const controller = createCanvasImageResourceController({
        queue: createCanvasMediaLoadQueue({ concurrency: 2 }),
        releaseObjectURL: (storageKey) => released.push(storageKey),
        deferRelease: (release) => deferredReleases.push(release),
        onChange: () => changed.resolve(),
    });
    const loaders = {
        thumbnail: async (signal: AbortSignal) => {
            thumbnailSignal = signal;
            thumbnailStarted.resolve();
            return thumbnail.promise;
        },
        original: async () => {
            originalStarted.resolve();
            return original.promise;
        },
    };
    const first = request("thumbnail", loaders);
    const second = { ...request("thumbnail", loaders), nodeId: "node-2" };

    controller.reconcile([first, second]);
    await thumbnailStarted.promise;
    controller.reconcile([request("original", loaders), second]);
    await originalStarted.promise;
    assert.equal(thumbnailSignal?.aborted, false);

    original.resolve(image("original"));
    await changed.promise;
    assert.equal(controller.get("node-1")?.variant, "original");

    changed = deferred<void>();
    thumbnail.resolve({ ...image("thumbnail"), url: "blob:shared-thumbnail" });
    await changed.promise;
    assert.equal(controller.get("node-1")?.variant, "original");
    assert.equal(controller.get("node-2")?.url, "blob:shared-thumbnail");
    deferredReleases.splice(0).forEach((release) => release());
    assert.deepEqual(released, []);

    controller.reconcile([second]);
    deferredReleases.splice(0).forEach((release) => release());
    assert.deepEqual(released, ["media:one:v1:original"]);
    assert.equal(controller.get("node-2")?.url, "blob:shared-thumbnail");

    controller.reconcile([]);
    deferredReleases.splice(0).forEach((release) => release());
    assert.deepEqual(released, ["media:one:v1:original", "media:one:v1:thumbnail"]);
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

test("promotes back to the original after a rapid thumbnail/original reversal", async () => {
    let originalCalls = 0;
    const controller = createCanvasImageResourceController({
        queue: createCanvasMediaLoadQueue({ concurrency: 1 }),
        releaseObjectURL: () => undefined,
        deferRelease: (release) => release(),
    });
    const loaders = {
        thumbnail: async () => image("thumbnail"),
        original: (signal: AbortSignal) => {
            originalCalls += 1;
            if (originalCalls > 1) return Promise.resolve(image("original"));
            return new Promise<UploadedImage>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
            });
        },
    };

    controller.reconcile([request("thumbnail", loaders)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.reconcile([request("original", loaders)]);
    await Promise.resolve();
    controller.reconcile([request("thumbnail", loaders)]);
    controller.reconcile([request("original", loaders)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(controller.get("node-1")?.variant, "original");
    assert.equal(originalCalls, 2);
});

test("failed image loads expose an error without an automatic retry loop", async () => {
    let changed!: () => void;
    const failed = new Promise<void>((resolve) => { changed = resolve; });
    let calls = 0;
    const controller = createCanvasImageResourceController({
        queue: createCanvasMediaLoadQueue({ concurrency: 1 }),
        releaseObjectURL: () => undefined,
        onChange: () => changed(),
    });
    const loaders = {
        thumbnail: async () => { calls++; throw new Error("image unavailable"); },
        original: async () => image("original"),
    };
    controller.reconcile([request("thumbnail", loaders)]);
    await failed;
    assert.equal(controller.errors().get("node-1"), "image unavailable");
    controller.reconcile([request("thumbnail", loaders)]);
    assert.equal(calls, 1);
    controller.reconcile([]);
    assert.equal(controller.errors().size, 0);
    controller.dispose();
});

test("same resource remains in memory for preview and is released after its final target disappears", async () => {
    let loads = 0;
    const released: string[] = [];
    const controller = createCanvasImageResourceController({ queue: createCanvasMediaLoadQueue({ concurrency: 1 }), releaseObjectURL: key => released.push(key), deferRelease: fn => fn() });
    const loaders = { thumbnail: async () => { loads++; return image("thumbnail"); }, original: async () => image("original") };
    controller.reconcile([request("thumbnail", loaders)]);
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.reconcile([{ ...request("thumbnail", loaders), priority: "interactive" }]);
    assert.equal(loads, 1);
    assert.deepEqual(released, []);
    controller.reconcile([]);
    assert.deepEqual(released, [image("thumbnail").storageKey]);
    controller.dispose();
});

test("failed loads wait for explicit retry and then recover", async () => {
    let attempts = 0;
    const controller = createCanvasImageResourceController({ queue: createCanvasMediaLoadQueue({ concurrency: 1 }), releaseObjectURL: () => {} });
    const loaders = { thumbnail: async () => { if (++attempts === 1) throw new Error("offline"); return image("thumbnail"); }, original: async () => image("original") };
    controller.reconcile([request("thumbnail", loaders)]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(controller.errors().get("node-1"), "offline");
    controller.reconcile([request("thumbnail", loaders)]);
    assert.equal(attempts, 1);
    controller.retry("node-1");
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(attempts, 2);
    assert.equal(controller.errors().size, 0);
    assert.equal(controller.get("node-1")?.url, "blob:thumbnail");
    controller.dispose();
});

test("reusing a node id for different media cannot display the previous resource", async () => {
    const controller = createCanvasImageResourceController({ queue: createCanvasMediaLoadQueue({ concurrency: 1 }), releaseObjectURL: () => {} });
    const loaders = { thumbnail: async () => image("thumbnail"), original: async () => image("original") };
    controller.reconcile([request("thumbnail", loaders)]);
    await new Promise(resolve => setTimeout(resolve, 0));
    const replacement = deferred<UploadedImage>();
    controller.reconcile([{ ...request("thumbnail", loaders), mediaId: "two", loadThumbnail: () => replacement.promise }]);
    assert.equal(controller.get("node-1"), undefined);
    replacement.resolve({ ...image("thumbnail"), mediaId: "two", storageKey: "media:two:thumbnail", url: "blob:two" });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(controller.get("node-1")?.mediaId, "two");
    controller.dispose();
});


test("effect cleanup and reactivation can load images again", async () => {
    const controller = createCanvasImageResourceController({ queue: createCanvasMediaLoadQueue({ concurrency: 1 }), releaseObjectURL: () => {} });
    const req = request("thumbnail", { thumbnail: async () => image("thumbnail"), original: async () => image("original") });
    controller.reconcile([req]);
    controller.dispose();
    controller.activate();
    controller.reconcile([req]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(controller.get("node-1")?.url, "blob:thumbnail");
    controller.dispose();
    assert.equal(controller.snapshot().size, 0);
});
