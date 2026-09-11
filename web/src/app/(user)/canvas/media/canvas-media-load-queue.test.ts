import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasMediaLoadQueue } from "./canvas-media-load-queue.ts";

function deferred<Value>() {
    let resolve: (value: Value) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<Value>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

test("deduplicates equivalent keys across consumers", async () => {
    const queue = createCanvasMediaLoadQueue({ concurrency: 1 });
    let calls = 0;
    const first = queue.request({ key: "media:a:original", priority: "visible-original", load: async () => ++calls });
    const second = queue.request({ key: "media:a:original", priority: "interactive", load: async () => ++calls });

    assert.equal(await first.promise, 1);
    assert.equal(await second.promise, 1);
    assert.equal(calls, 1);
});

test("starts a promoted interactive task before an earlier prefetch once capacity becomes free", async () => {
    const queue = createCanvasMediaLoadQueue({ concurrency: 1 });
    const running = deferred<string>();
    const started: string[] = [];
    const first = queue.request({
        key: "current",
        priority: "visible-thumbnail",
        load: async () => {
            started.push("current");
            return running.promise;
        },
    });
    const prefetch = queue.request({ key: "prefetch", priority: "prefetch", load: async () => (started.push("prefetch"), "prefetch") });
    const interactive = queue.request({ key: "interactive", priority: "interactive", load: async () => (started.push("interactive"), "interactive") });

    running.resolve("current");
    await first.promise;
    assert.equal(await interactive.promise, "interactive");
    assert.equal(await prefetch.promise, "prefetch");
    assert.deepEqual(started, ["current", "interactive", "prefetch"]);
});

test("does not start a queued load after every consumer releases it", async () => {
    const queue = createCanvasMediaLoadQueue({ concurrency: 1 });
    const gate = deferred<string>();
    const current = queue.request({ key: "current", priority: "interactive", load: async () => gate.promise });
    let calls = 0;
    const obsolete = queue.request({ key: "obsolete", priority: "prefetch", load: async () => ++calls });
    obsolete.release();

    await assert.rejects(obsolete.promise, { name: "AbortError" });
    gate.resolve("current");
    await current.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 0);
});

test("aborts a running load only after its final consumer releases", async () => {
    const queue = createCanvasMediaLoadQueue({ concurrency: 1 });
    let aborted = false;
    const load = (signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
                "abort",
                () => {
                    aborted = true;
                    reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                },
                { once: true },
            );
        });
    const first = queue.request({ key: "media:a:original", priority: "visible-original", load });
    const second = queue.request({ key: "media:a:original", priority: "visible-original", load });

    await Promise.resolve();
    first.release();
    assert.equal(aborted, false);
    second.release();
    await assert.rejects(first.promise, { name: "AbortError" });
    await assert.rejects(second.promise, { name: "AbortError" });
    assert.equal(aborted, true);
});

test("starts a fresh same-key load when an aborted producer is immediately requested again", async () => {
    const queue = createCanvasMediaLoadQueue({ concurrency: 1 });
    const started = deferred<void>();
    let loadCalls = 0;
    const first = queue.request({
        key: "media:a:original",
        priority: "visible-original",
        load: (signal) => {
            loadCalls += 1;
            started.resolve();
            return new Promise<string>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
            });
        },
    });
    await started.promise;

    const firstRejected = assert.rejects(first.promise, { name: "AbortError" });
    first.release();
    const replacement = queue.request({
        key: "media:a:original",
        priority: "visible-original",
        load: async () => {
            loadCalls += 1;
            return "fresh-original";
        },
    });

    await firstRejected;
    assert.equal(await replacement.promise, "fresh-original");
    assert.equal(loadCalls, 2);
});

test("keeps the real loader peak at four while 40 originals replace canceled thumbnails", async () => {
    const queue = createCanvasMediaLoadQueue({ concurrency: 4 });
    const thumbnailGates = Array.from({ length: 4 }, () => deferred<string>());
    const thumbnailStarted = Array.from({ length: 4 }, () => deferred<void>());
    const originalGates = Array.from({ length: 40 }, () => deferred<string>());
    const originalStarted = Array.from({ length: 40 }, () => deferred<void>());
    const abortedThumbnails = new Set<number>();
    const startedOriginals: number[] = [];
    let active = 0;
    let peak = 0;

    const thumbnails = thumbnailGates.map((gate, index) =>
        queue.request({
            key: `canvas:media-${index}:thumbnail`,
            priority: "visible-thumbnail",
            load: async (signal) => {
                active += 1;
                peak = Math.max(peak, active);
                thumbnailStarted[index].resolve();
                signal.addEventListener("abort", () => abortedThumbnails.add(index), { once: true });
                try {
                    return await gate.promise;
                } finally {
                    active -= 1;
                }
            },
        }),
    );
    await Promise.all(thumbnailStarted.map((started) => started.promise));

    const originals = originalGates.map((gate, index) =>
        queue.request({
            key: `canvas:media-${index}:original`,
            priority: "interactive",
            load: async () => {
                active += 1;
                peak = Math.max(peak, active);
                startedOriginals.push(index);
                originalStarted[index].resolve();
                try {
                    return await gate.promise;
                } finally {
                    active -= 1;
                }
            },
        }),
    );

    const canceled = thumbnails.map((thumbnail) => assert.rejects(thumbnail.promise, { name: "AbortError" }));
    thumbnails.forEach((thumbnail) => thumbnail.release());
    await Promise.all(canceled);
    assert.deepEqual([...abortedThumbnails].sort((left, right) => left - right), [0, 1, 2, 3]);
    assert.equal(active, 4);
    assert.equal(peak, 4);
    assert.deepEqual(startedOriginals, []);

    thumbnailGates[0].resolve("stale-thumbnail-0");
    await originalStarted[0].promise;
    assert.equal(active, 4);
    assert.deepEqual(startedOriginals, [0]);

    thumbnailGates.slice(1).forEach((gate, index) => gate.resolve(`stale-thumbnail-${index + 1}`));
    await Promise.all(originalStarted.slice(1, 4).map((started) => started.promise));
    assert.equal(active, 4);
    assert.deepEqual(startedOriginals, [0, 1, 2, 3]);

    originalGates.forEach((gate, index) => gate.resolve(`original-${index}`));
    assert.deepEqual(
        await Promise.all(originals.map((original) => original.promise)),
        Array.from({ length: 40 }, (_, index) => `original-${index}`),
    );
    assert.equal(startedOriginals.length, 40);
    assert.equal(active, 0);
    assert.equal(peak, 4);
});
