import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import type { AxiosResponse } from "axios";
import { useAssetStore } from "./use-asset-store.ts";
import { createCanvasLocalImageUploadController } from "../features/canvas/media/canvas-local-image-upload-controller.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}
async function flush() {
    for (let i = 0; i < 60; i++) await Promise.resolve();
}
async function harness(run: (h: { tick: () => void; requests: { url: string; resolve: (id: string) => void }[]; writes: string[]; blockCache: () => () => void }) => Promise<void>) {
    const options = useAssetStore.persist.getOptions();
    const adapter = axios.defaults.adapter;
    const timeout = globalThis.setTimeout;
    const clear = globalThis.clearTimeout;
    const timers = new Map<number, () => void>();
    let id = 0;
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
        if (delay !== 100) return timeout(callback, delay);
        timers.set(++id, callback);
        return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: number) => {
        if (!timers.delete(timer)) clear(timer);
    }) as typeof clearTimeout;
    const requests: { url: string; resolve: (id: string) => void }[] = [];
    axios.defaults.adapter = async (config) => {
        const response = deferred<AxiosResponse>();
        requests.push({
            url: config.url!,
            resolve: (id) =>
                response.resolve({
                    config,
                    status: 200,
                    statusText: "OK",
                    headers: {},
                    data: { code: 0, data: { items: config.url!.endsWith("private-folders") ? [{ id, title: id, parentId: "", createdAt: "2026-09-01" }] : [], total: 1 } },
                }),
        });
        return response.promise;
    };
    const writes: string[] = [];
    let cache: Promise<null> = Promise.resolve(null);
    useAssetStore.persist.setOptions({
        storage: {
            getItem: () => cache,
            setItem: async (name, value) => {
                writes.push(`${name}:${value.state.folders[0]?.id}`);
            },
            removeItem: async () => undefined,
        },
    });
    try {
        await run({
            tick: () => {
                const callbacks = [...timers.values()];
                timers.clear();
                callbacks.forEach((callback) => callback());
            },
            requests,
            writes,
            blockCache: () => {
                const pending = deferred<null>();
                cache = pending.promise;
                return () => pending.resolve(null);
            },
        });
    } finally {
        axios.defaults.adapter = adapter;
        globalThis.setTimeout = timeout;
        globalThis.clearTimeout = clear;
        useAssetStore.persist.setOptions(options);
        useAssetStore.setState({ assets: [], folders: [] });
    }
}

test("hydrate remote response is invalidated by a later refresh and callers await trailing", async () =>
    harness(async (h) => {
        const hydrate = useAssetStore.getState().hydrate("A");
        await flush();
        h.tick();
        assert.equal(h.requests.length, 3);
        const refresh = useAssetStore.getState().refreshFromServer();
        h.requests.slice(0, 3).forEach((request) => request.resolve("old"));
        await flush();
        h.tick();
        assert.deepEqual(h.writes, []);
        assert.equal(h.requests.length, 6);
        h.requests.slice(3).forEach((request) => request.resolve("new"));
        await Promise.all([hydrate, refresh]);
        assert.equal(useAssetStore.getState().folders[0]?.id, "new");
        assert.equal(h.writes.length, 1);
    }));

for (const sequence of [["B"], ["B", "A"]])
    test(`old A remote response cannot persist after A → ${sequence.join(" → ")}`, async () =>
        harness(async (h) => {
            const old = useAssetStore.getState().hydrate("A");
            await flush();
            h.tick();
            const hydrations = [old];
            for (const uid of sequence) {
                hydrations.push(useAssetStore.getState().hydrate(uid));
                await flush();
            }
            h.tick();
            assert.equal(h.requests.length, 6);
            h.requests.slice(3).forEach((request) => request.resolve("new session"));
            await Promise.all(hydrations);
            const writes = [...h.writes];
            h.requests.slice(0, 3).forEach((request) => request.resolve("old session"));
            await flush();
            assert.equal(useAssetStore.getState().folders[0]?.id, "new session");
            assert.deepEqual(h.writes, writes);
        }));

test("refresh waits for local hydration; earlier refresh cannot overwrite the new hydrate", async () =>
    harness(async (h) => {
        const old = useAssetStore.getState().refreshFromServer();
        const cancelled = assert.rejects(old, { name: "AbortError" });
        h.tick();
        const release = h.blockCache();
        const hydrate = useAssetStore.getState().hydrate("B");
        const next = useAssetStore.getState().refreshFromServer();
        h.tick();
        assert.equal(h.requests.length, 3);
        release();
        await flush();
        h.tick();
        assert.equal(h.requests.length, 6);
        h.requests.slice(3).forEach((request) => request.resolve("fresh"));
        await Promise.all([hydrate, next, cancelled]);
        h.requests.slice(0, 3).forEach((request) => request.resolve("obsolete"));
        await flush();
        assert.equal(useAssetStore.getState().folders[0]?.id, "fresh");
    }));

test("twenty successful uploads plus failure and cancellation do not wedge the real store scheduler", async () =>
    harness(async (h) => {
        const refreshes: Promise<void>[] = [];
        const controller = createCanvasLocalImageUploadController({
            upload: async (file, _intent, options) => {
                if (file.name === "fail") throw new Error("upload failed");
                if (file.name === "cancel") return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancel"), { name: "AbortError" }))));
                return { mediaId: file.name, url: "" };
            },
            promote: async (image) => image,
            onCompleted: () => {
                refreshes.push(useAssetStore.getState().refreshFromServer());
            },
            onProgress: () => undefined,
            onFailed: () => undefined,
        });
        const image = { url: "", storageKey: "local", width: 1, height: 1, bytes: 1, mimeType: "image/png" };
        const tasks = [...Array.from({ length: 20 }, (_, i) => String(i)), "fail", "cancel"].map((name) => controller.start({ nodeId: name, file: new File([], name), image, intent: "library" }));
        controller.cancel("cancel");
        await Promise.all(tasks);
        assert.equal(refreshes.length, 20);
        assert.equal(h.requests.length, 0);
        h.tick();
        assert.equal(h.requests.length, 3);
        h.requests.forEach((request) => request.resolve("uploaded"));
        await Promise.all(refreshes);
        const later = useAssetStore.getState().refreshFromServer();
        h.tick();
        assert.equal(h.requests.length, 6);
        h.requests.slice(3).forEach((request) => request.resolve("later"));
        await later;
    }));
