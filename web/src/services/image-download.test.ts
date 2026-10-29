import assert from "node:assert/strict";
import test from "node:test";
import { createImageDownloadQueue, type ImageDownloadState, type ImageDownloadTarget } from "./image-download";
import { deferred } from "@/test-utils/source-component";

const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
const targets = (count: number): ImageDownloadTarget[] => Array.from({ length: count }, (_, i) => ({ mediaId: `media-${i}`, filename: `image-${i}` }));

test("120 cache hits are paced at the actual save boundary and publish truthful progress", async () => {
    let time = 0, activeReads = 0, maxReads = 0;
    const saves: { filename: string; at: number; blob: Blob }[] = [];
    const progress: ImageDownloadState[] = [];
    const queue = createImageDownloadQueue({
        read: async () => { activeReads++; maxReads = Math.max(maxReads, activeReads); await Promise.resolve(); activeReads--; return image; },
        save: (blob, filename) => saves.push({ blob, filename, at: time }),
        now: () => time,
        wait: async (ms, signal) => { signal.throwIfAborted(); time += ms; },
    });
    queue.subscribe(() => { const state = queue.getSnapshot(); if (state) progress.push(state); });
    assert.equal(await queue.start(targets(120)), true);
    assert.equal(saves.length, 120);
    assert.equal(maxReads, 1);
    assert.equal(new Set(saves.map(s => s.filename)).size, 120);
    assert.ok(saves.every((save, i) => save.blob === image && (!i || save.at - saves[i - 1]!.at >= 200)));
    for (const state of progress) {
        assert.equal(state.processed, state.issued + state.failed);
        assert.ok(state.processed <= state.total);
    }
    assert.deepEqual([queue.getSnapshot()?.phase, queue.getSnapshot()?.processed, queue.getSnapshot()?.issued, queue.getSnapshot()?.failed], ["completed", 120, 120, 0]);
});

test("selection changes cannot mutate a running batch, duplicate starts are blocked, and retry only reads failed targets", async () => {
    const gate = deferred<void>();
    const loaded: string[] = [], saved: string[] = [];
    let broken = true, time = 0;
    const queue = createImageDownloadQueue({
        read: async target => {
            loaded.push(target.mediaId!);
            if (target.mediaId === "media-0") await gate.promise;
            if (target.mediaId === "media-1" && broken) throw new Error("图片读取失败");
            return image;
        }, save: (_, name) => saved.push(name), now: () => time, wait: async ms => { time += ms; },
    });
    const selection = targets(3);
    const running = queue.start(selection);
    assert.equal(queue.isBusy(), true);
    assert.equal(await queue.start(targets(2)), false);
    selection[2]!.mediaId = "different-run"; selection.splice(0, 2);
    gate.resolve(); await running;
    assert.deepEqual(loaded, ["media-0", "media-1", "media-2"]);
    assert.deepEqual(saved, ["image-0.jpg", "image-2.jpg"]);
    assert.deepEqual([queue.getSnapshot()?.processed, queue.getSnapshot()?.issued, queue.getSnapshot()?.failed], [3, 2, 1]);
    assert.match(queue.getSnapshot()?.error || "", /图片读取失败/);
    broken = false; assert.equal(await queue.retry(), true);
    assert.deepEqual(loaded, ["media-0", "media-1", "media-2", "media-1"]);
    assert.deepEqual(saved, ["image-0.jpg", "image-2.jpg", "image-1.jpg"]);
    assert.equal(queue.getSnapshot()?.failed, 0);
    queue.dismiss(); assert.equal(queue.getSnapshot(), null);
});

test("cancellation during an in-flight read prevents late saves and does not report 100 percent", async () => {
    const gate = deferred<Blob>(); const saved: string[] = [];
    let signal!: AbortSignal;
    const queue = createImageDownloadQueue({ read: async (_, s) => { signal = s; return gate.promise; }, save: (_, name) => saved.push(name) });
    const running = queue.start(targets(120));
    queue.cancel(); assert.equal(signal.aborted, true);
    gate.resolve(image); await running;
    assert.deepEqual(saved, []);
    assert.equal(queue.getSnapshot()?.phase, "cancelled");
    assert.equal(queue.getSnapshot()?.processed, 0);
    assert.equal(queue.isBusy(), false);
});

test("cancellation interrupts the real pacing timer before the second save", async () => {
    const waiting = deferred<void>(); const saved: string[] = [];
    const queue = createImageDownloadQueue({ read: async () => image, save: (_, name) => saved.push(name) });
    queue.subscribe(() => { if (queue.getSnapshot()?.phase === "waiting" && queue.getSnapshot()?.issued === 1) waiting.resolve(); });
    const running = queue.start(targets(120));
    await waiting.promise; queue.cancel(); await running;
    assert.deepEqual(saved, ["image-0.jpg"]);
    assert.deepEqual([queue.getSnapshot()?.phase, queue.getSnapshot()?.processed], ["cancelled", 1]);
});
