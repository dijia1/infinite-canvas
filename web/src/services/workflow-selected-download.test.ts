import assert from "node:assert/strict";
import test from "node:test";
import { sourceBehavior } from "@/test-utils/source-behavior";
import { createImageDownloadQueue } from "./image-download";

test("workflow selection uses the shared queue and blocks repeat saves without changing run targets", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const queue = createImageDownloadQueue({ read: async () => { calls++; await gate; return new Blob(["original"], { type: "image/png" }); }, save() {}, wait: async () => {} });
    const action = sourceBehavior(new URL("../features/workflows/workflow-editor.tsx", import.meta.url), {
        selectedImageDownload: { targets: [{ mediaId: "a", filename: "a" }] }, imageDownloadLoading: false, imageDownloadFailed: false,
        downloadController: { current: null }, setImageMenu() {}, imageDownloads: { queue },
    }).named("downloadImageSelection");
    const first = action(); await action(); assert.equal(calls, 1);
    release(); await first;
    await action(); assert.equal(calls, 2);
});

test("workflow ZIP download and unresolved output details cannot start a second selected batch", async () => {
    let calls = 0;
    const dependencies = {
        selectedImageDownload: { targets: [{ mediaId: "a", filename: "a" }] }, imageDownloadLoading: false, imageDownloadFailed: false,
        downloadController: { current: new AbortController() as AbortController | null }, setImageMenu() {}, imageDownloads: { queue: { start: async () => { calls++; } } },
    };
    const load = () => sourceBehavior(new URL("../features/workflows/workflow-editor.tsx", import.meta.url), dependencies).named("downloadImageSelection");
    await load()(); assert.equal(calls, 0);
    dependencies.downloadController.current = null; dependencies.imageDownloadLoading = true;
    await load()(); assert.equal(calls, 0);
});
