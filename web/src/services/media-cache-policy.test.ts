import assert from "node:assert/strict";
import test from "node:test";

import { coalesceMediaLoad, resolveOriginal, resolvePreview } from "./media-cache-policy.ts";

test("resolveOriginal returns a cached original without starting a remote load", async () => {
    let remoteCalls = 0;

    const original = await resolveOriginal({
        readOriginal: async () => "blob:local-original",
        loadRemoteOriginal: async () => {
            remoteCalls += 1;
            return "blob:remote-original";
        },
    });

    assert.equal(original, "blob:local-original");
    assert.equal(remoteCalls, 0);
});

test("resolvePreview derives a preview from a cached original without starting a remote load", async () => {
    let remoteCalls = 0;
    let derivedFrom = "";

    const preview = await resolvePreview({
        readPreview: async () => undefined,
        readOriginal: async () => "blob:local-original",
        createPreview: async (original) => {
            derivedFrom = original;
            return "blob:derived-preview";
        },
        loadRemotePreview: async () => {
            remoteCalls += 1;
            return "blob:remote-preview";
        },
    });

    assert.equal(preview, "blob:derived-preview");
    assert.equal(derivedFrom, "blob:local-original");
    assert.equal(remoteCalls, 0);
});

test("resolvePreview uses a cached preview without reading the original or remote media", async () => {
    const preview = await resolvePreview({
        readPreview: async () => "blob:cached-preview",
        readOriginal: async () => {
            throw new Error("预览缓存命中时不应读取原图");
        },
        createPreview: async () => {
            throw new Error("预览缓存命中时不应生成缩略图");
        },
        loadRemotePreview: async () => {
            throw new Error("预览缓存命中时不应请求远端图片");
        },
    });

    assert.equal(preview, "blob:cached-preview");
});

test("resolvePreview keeps the local original when preview derivation fails", async () => {
    let remoteCalls = 0;

    const preview = await resolvePreview({
        readPreview: async () => undefined,
        readOriginal: async () => "blob:local-original",
        createPreview: async () => {
            throw new Error("浏览器无法转换 WebP");
        },
        loadRemotePreview: async () => {
            remoteCalls += 1;
            return "blob:remote-preview";
        },
    });

    assert.equal(preview, "blob:local-original");
    assert.equal(remoteCalls, 0);
});

test("resolvePreview loads a remote preview only when neither preview nor original is cached", async () => {
    let previewCreationCalls = 0;
    let remoteCalls = 0;

    const preview = await resolvePreview({
        readPreview: async () => undefined,
        readOriginal: async () => undefined,
        createPreview: async () => {
            previewCreationCalls += 1;
            return "blob:derived-preview";
        },
        loadRemotePreview: async () => {
            remoteCalls += 1;
            return "blob:remote-preview";
        },
    });

    assert.equal(preview, "blob:remote-preview");
    assert.equal(previewCreationCalls, 0);
    assert.equal(remoteCalls, 1);
});

test("coalesceMediaLoad shares one remote load between concurrent callers with the same key", async () => {
    let remoteCalls = 0;
    let resolveRemote: ((value: string) => void) | undefined;
    const remoteLoad = () => {
        remoteCalls += 1;
        return new Promise<string>((resolve) => {
            resolveRemote = resolve;
        });
    };

    const first = coalesceMediaLoad("preview:media-1", remoteLoad);
    const second = coalesceMediaLoad("preview:media-1", remoteLoad);
    assert.equal(remoteCalls, 1);

    resolveRemote?.("blob:remote-preview");
    assert.deepEqual(await Promise.all([first, second]), ["blob:remote-preview", "blob:remote-preview"]);
});

test("coalesceMediaLoad releases a rejected load so a later request can retry", async () => {
    let attempts = 0;
    const load = () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("签名地址已过期"));
        return Promise.resolve("blob:retry-success");
    };

    await assert.rejects(() => coalesceMediaLoad("preview:media-retry", load), /签名地址已过期/);
    assert.equal(await coalesceMediaLoad("preview:media-retry", load), "blob:retry-success");
    assert.equal(attempts, 2);
});

test("coalesceMediaLoad does not share an already aborted producer with a fresh request", async () => {
    const cancelled = new AbortController();
    const fresh = new AbortController();
    let loadCalls = 0;
    const first = coalesceMediaLoad(
        "original:media-restart",
        () => {
            loadCalls += 1;
            return new Promise<string>((_resolve, reject) => {
                cancelled.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
            });
        },
        { signal: cancelled.signal },
    );
    const firstRejected = assert.rejects(first, { name: "AbortError" });
    cancelled.abort();

    const replacement = coalesceMediaLoad("original:media-restart", async () => {
        loadCalls += 1;
        return "blob:fresh-original";
    }, { signal: fresh.signal });

    await firstRejected;
    assert.equal(await replacement, "blob:fresh-original");
    assert.equal(loadCalls, 2);
});
