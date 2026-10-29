import assert from "node:assert/strict";
import test from "node:test";
import { sourceModule } from "@/test-utils/source-component";
import { imageBlobFromResponse } from "./image-blob";
import type { readImageDownload } from "./image-download";

function reader() {
    const original = new Blob(["original bytes"], { type: "image/png" });
    const calls: string[] = [];
    let remoteBlob: Blob | null = original;
    const module = sourceModule<{ readImageDownload: typeof readImageDownload }>(new URL("./image-download.ts", import.meta.url), {
        "file-saver": { saveAs() {} }, "@/lib/app-path": { appApiPath: (url: string) => url }, "./image-blob": { imageBlobFromResponse },
        "./api/public-images": { fetchPublicImageAccess: async (id: string, signal: AbortSignal) => { assert.ok(signal); calls.push(`public:${id}`); return { mediaId: "public-media", url: "public-original" }; } },
        "./image-storage": {
            getImageBlob: async (key: string) => key === "local-original" ? original : key.endsWith(":original") ? remoteBlob : null,
            mediaIdFromImageStorageKey: (key?: string) => key === "legacy-media-key" ? "legacy-media" : key === "preview:remote" ? "remote" : undefined,
            imageStorageKeyForMedia: (id: string) => `${id}:original`,
            resolveRemoteImage: async (id: string) => { calls.push(`resolve:${id}`); return "signed-original"; },
            loadMediaImage: async (id: string, resolve: string | (() => Promise<string>), options: { signal: AbortSignal }) => { options.signal.throwIfAborted(); calls.push(`load:${id}:${typeof resolve === "string" ? resolve : await resolve()}`); return { storageKey: `${id}:original` }; },
        },
    }, { fetch: async (url: string, options: { signal: AbortSignal }) => { options.signal.throwIfAborted(); calls.push(`fetch:${url}`); return new Response(original, { headers: { "Content-Type": original.type } }); } });
    return { read: module.readImageDownload, original, calls, missing: () => { remoteBlob = null; } };
}

test("local replacement cache takes priority and remote media downloads use original blobs", async () => {
    const f = reader(), signal = new AbortController().signal;
    assert.equal(await f.read({ filename: "replacement", storageKey: "local-original", mediaId: "old-media" }, signal), f.original);
    assert.deepEqual(f.calls, []);
    assert.equal(await f.read({ filename: "remote", mediaId: "remote-media" }, signal), f.original);
    assert.deepEqual(f.calls, ["resolve:remote-media", "load:remote-media:signed-original"]);
});

test("legacy URLs are fetched into blobs and public access resolves the original media identity", async () => {
    const f = reader(), signal = new AbortController().signal;
    const blob = await f.read({ filename: "legacy", url: "https://fixture.test/original.png" }, signal);
    assert.deepEqual(await blob.arrayBuffer(), await f.original.arrayBuffer());
    assert.equal(await f.read({ filename: "public", publicImageId: "public-1" }, signal), f.original);
    assert.deepEqual(f.calls, ["fetch:https://fixture.test/original.png", "public:public-1", "load:public-media:public-original"]);
});

test("missing originals fail instead of saving thumbnails or empty files", async () => {
    const f = reader(); f.missing();
    await assert.rejects(f.read({ filename: "missing", mediaId: "missing" }, new AbortController().signal), /图片原图不可用/);
});

test("a thumbnail cache reference resolves the original variant for saving", async () => {
    const f = reader();
    assert.equal(await f.read({ filename: "overview", storageKey: "preview:remote" }, new AbortController().signal), f.original);
    assert.deepEqual(f.calls, []);
});

test("public image access forwards cancellation to the HTTP request", async () => {
    const abort = new AbortController();
    let received: AbortSignal | undefined;
    const api = sourceModule<{ fetchPublicImageAccess: (id: string, signal: AbortSignal) => Promise<unknown> }>(new URL("./api/public-images.ts", import.meta.url), {
        axios: {}, "@/lib/app-path": { appApiPath: (url: string) => url }, "@/services/api/request": {},
    }, { fetch: (_url: string, options: { signal: AbortSignal }) => {
        received = options.signal;
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    } });
    const pending = api.fetchPublicImageAccess("public-1", abort.signal);
    assert.equal(received, abort.signal); abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
});
