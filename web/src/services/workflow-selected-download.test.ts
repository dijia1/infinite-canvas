import assert from "node:assert/strict";
import test from "node:test";
import { sourceModule } from "@/test-utils/source-component";
import { sourceBehavior } from "@/test-utils/source-behavior";
import type { downloadSelectedWorkflowImages } from "./workflow-download";

function downloader(load: (id: string, remote: () => Promise<string>) => Promise<{ storageKey: string; mimeType: string }>) {
    const original = new Blob([new Uint8Array([255, 216, 255, 224, 1, 2, 3])], { type: "image/jpeg" });
    const saved: { blob: Blob; filename: string }[] = [];
    const { downloadSelectedWorkflowImages: run } = sourceModule<{ downloadSelectedWorkflowImages: typeof downloadSelectedWorkflowImages }>(new URL("./workflow-download.ts", import.meta.url), {
        "file-saver": { saveAs: (blob: Blob, filename: string) => saved.push({ blob, filename }) },
        "./image-storage": { loadMediaImage: load, getImageBlob: async () => original, resolveRemoteImage: async (id: string) => `original/${id}` },
        "@/lib/app-path": { appApiPath: (path: string) => path },
        "./api/request": {},
    });
    return { run, saved, original };
}

test("selected downloads keep a fixed target list, use original bytes and continue after individual failure", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let started!: () => void; const loading = new Promise<void>(r => { started = r; });
    const calls: string[] = [];
    const f = downloader(async (id, remote) => {
        calls.push(await remote());
        if (id === "first") { started(); await gate; }
        if (id === "broken") throw new Error("404");
        return { storageKey: `${id}:original`, mimeType: "image/png" };
    });
    const targets = [{ mediaId: "first", filename: "input" }, { mediaId: "broken", filename: "bad" }, { mediaId: "last", filename: "output" }];
    const pending = f.run(targets, new AbortController().signal);
    await loading; targets[2]!.mediaId = "new-run"; targets.length = 1; release();
    assert.deepEqual(await pending, { saved: 2, failed: 1 });
    assert.deepEqual(calls, ["original/first", "original/broken", "original/last"]);
    assert.deepEqual(f.saved.map(item => item.filename), ["input.jpg", "output.jpg"]);
    for (const item of f.saved) assert.deepEqual(await item.blob.arrayBuffer(), await f.original.arrayBuffer());
});

test("leaving the editor during load never starts a late download", async () => {
    const abort = new AbortController();
    const f = downloader(async () => { abort.abort(); return { storageKey: "original", mimeType: "image/png" }; });
    await assert.rejects(f.run([{ mediaId: "a", filename: "a" }], abort.signal), { name: "AbortError" });
    assert.deepEqual(f.saved, []);
});

test("editor prevents repeat download clicks while a previous selection is loading", async () => {
    let resolve!: () => void; const gate = new Promise<void>(r => { resolve = r; });
    let calls = 0;
    const action = sourceBehavior(new URL("../features/workflows/workflow-editor.tsx", import.meta.url), {
        selectedImageDownload: { targets: [{ mediaId: "a", filename: "a" }] }, imageDownloadLoading: false, imageDownloadFailed: false,
        downloadController: { current: null }, setDownloading() {}, setImageMenu() {},
        downloadSelectedWorkflowImages: async () => { calls++; await gate; return { saved: 1, failed: 0 }; },
        message: { success() {}, warning() {}, error() {} },
    }).named("downloadImageSelection");
    const first = action(); await action(); assert.equal(calls, 1); resolve(); await first;
    await action(); assert.equal(calls, 2);
});
