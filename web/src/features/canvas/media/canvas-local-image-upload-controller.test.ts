import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasLocalImageUploadController } from "./canvas-local-image-upload-controller.ts";

const file = new File(["local image"], "local.png", { type: "image/png" });
const localImage = { url: "blob:local", storageKey: "image:local", width: 640, height: 480, bytes: file.size, mimeType: "image/png" };

for (const phase of ["upload", "promote"] as const) {
    for (const action of ["cancel", "dispose"] as const) {
        test(`${action} ignores ${phase} completion even when the dependency resolves after abort`, async () => {
            let finish!: () => void;
            const deferred = new Promise<void>((resolve) => { finish = resolve; });
            const completed: string[] = [];
            let promoting!: () => void;
            const promotionStarted = new Promise<void>((resolve) => { promoting = resolve; });
            const controller = createCanvasLocalImageUploadController({
                upload: async () => { if (phase === "upload") await deferred; return { mediaId: "old", url: "remote" }; },
                promote: async (image) => { promoting(); if (phase === "promote") await deferred; return image; },
                onProgress: () => undefined, onFailed: () => undefined,
                onCompleted: (_node, _image, remote) => { completed.push(remote.mediaId); },
            });
            const running = controller.start({ nodeId: "A", file, image: localImage, intent: "canvas" });
            if (phase === "promote") await promotionStarted;
            if (action === "cancel") controller.cancel("A"); else controller.dispose();
            finish();
            await running;
            assert.deepEqual(completed, [], "cancelled uploads must never update restored nodes");
            assert.equal(controller.isActive("A"), false);
        });
    }
}

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

test("first uploads, retries and restored uploads share three actual request slots", async () => {
    const gates: Array<() => void> = [];
    const started: string[] = [];
    const completed: string[] = [];
    let live = 0, peak = 0;
    const controller = createCanvasLocalImageUploadController({
        upload: async (file) => {
            started.push(file.name);
            peak = Math.max(peak, ++live);
            await new Promise<void>(resolve => gates.push(resolve));
            live--;
            return { mediaId: file.name, url: "remote" };
        },
        promote: async image => image,
        onProgress: () => undefined, onFailed: () => undefined,
        onCompleted: (_id, _image, remote) => { completed.push(remote.mediaId); },
    });
    const start = (nodeId: string, name = nodeId) => controller.start({ nodeId, file: new File(["x"], name), image: localImage, intent: "library" });
    const tasks = [start("first"), start("retry"), start("restore"), start("queued-cancel"), start("queued")];
    assert.deepEqual(started, ["first", "retry", "restore"]);
    controller.cancel("queued-cancel");
    await tasks[3];
    // Requests that ignore abort still occupy a slot until they actually settle.
    tasks.push(start("first", "replacement"));
    assert.equal(started.length, 3);
    gates[1](); await tasks[1];
    assert.deepEqual(started, ["first", "retry", "restore", "queued"]);
    gates[0](); await tasks[0];
    assert.equal(started.at(-1), "replacement");
    gates[2](); gates[3](); gates[4]();
    await Promise.all(tasks);
    assert.equal(peak, 3);
    assert.equal(completed.includes("first"), false);
    assert.equal(completed.includes("queued-cancel"), false);
    assert.equal(completed.includes("replacement"), true);
});

test("dispose settles queued work without starting requests and permits later recovery", async () => {
    const gates: Array<() => void> = [];
    let calls = 0;
    const controller = createCanvasLocalImageUploadController({
        upload: async () => { calls++; await new Promise<void>(resolve => gates.push(resolve)); return { mediaId: "m", url: "remote" }; },
        promote: async image => image, onProgress: () => undefined, onFailed: () => undefined, onCompleted: () => undefined,
    });
    const start = (nodeId: string) => controller.start({ nodeId, file, image: localImage, intent: "library" });
    const tasks = [start("a"), start("b"), start("c"), start("d")];
    controller.dispose();
    await tasks[3];
    assert.equal(calls, 3);
    const resumed = start("restored");
    assert.equal(calls, 3);
    gates[0](); await tasks[0];
    assert.equal(calls, 4);
    gates[1](); gates[2](); gates[3]();
    await Promise.all([...tasks, resumed]);
});

test("acknowledged remote identity survives a later local cache promotion failure", async () => {
    const events: string[] = [];
    const controller = createCanvasLocalImageUploadController({
        upload: async () => ({ mediaId: "accepted", url: "remote" }),
        onUploaded: (_id, remote) => { events.push(`accepted:${remote.mediaId}`); },
        promote: async () => { throw new Error("cache unavailable"); },
        onProgress: () => undefined, onCompleted: () => events.push("complete"), onFailed: () => events.push("failed"),
    });
    await controller.start({ nodeId: "node", file, image: localImage, intent: "library" });
    assert.deepEqual(events, ["accepted:accepted", "failed"]);
});
