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
