import assert from "node:assert/strict";
import test from "node:test";

import type { UploadedImage } from "@/services/image-storage";
import { deferred, flushAsync, hookHarness, sourceModule } from "@/test-utils/source-component";
import type { useVisibleMediaPreview } from "./use-visible-media-preview";

const hookURL = new URL("./use-visible-media-preview.ts", import.meta.url);

function image(key: string): UploadedImage {
    return { storageKey: key, url: `blob:${key}`, width: 10, height: 10, bytes: 10, mimeType: "image/png" };
}

function previewEnvironment(withObserver = true) {
    let currentHooks!: ReturnType<typeof hookHarness>["hooks"];
    const releases: string[] = [];
    const observers: Observer[] = [];
    class Observer {
        target: unknown;
        disconnected = false;
        constructor(readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void, readonly options: { rootMargin: string }) {
            observers.push(this);
        }
        observe(target: unknown) { this.target = target; }
        disconnect() { this.disconnected = true; }
        intersect(isIntersecting: boolean) { this.callback([{ isIntersecting }]); }
    }
    const module = sourceModule<{ useVisibleMediaPreview: typeof useVisibleMediaPreview }>(hookURL, {
        react: {
            useRef: (value: unknown) => currentHooks.useRef(value),
            useState: (value: unknown) => currentHooks.useState(value),
            useEffect: (setup: () => void | (() => void), dependencies: readonly unknown[]) => currentHooks.useEffect(setup, dependencies),
        },
        "@/services/image-storage": { releaseImageObjectURL: (key: string) => releases.push(key) },
    }, { IntersectionObserver: withObserver ? Observer : undefined });
    return {
        releases,
        observers,
        mount(props: Parameters<typeof useVisibleMediaPreview>[0]) {
            const harness = hookHarness();
            const target = {} as HTMLDivElement;
            const render = () => harness.render(() => {
                currentHooks = harness.hooks;
                return module.useVisibleMediaPreview(props);
            }, (result) => { result.ref.current = target; });
            const initial = render();
            const observer = observers.find((item) => item.target === target);
            return { render, initial, observer, unmount: () => harness.unmount(), get postUnmountUpdates() { return harness.postUnmountUpdates; } };
        },
    };
}

test("preview loads wait for the viewport and share a four-request queue that advances after success and failure", async (t) => {
    const environment = previewEnvironment();
    const started: number[] = [];
    const requests = Array.from({ length: 6 }, () => deferred<UploadedImage>());
    const previews = requests.map((request, index) => environment.mount({
        identity: `media-${index}`, enabled: true, fallback: "fallback.png",
        load: () => { started.push(index); return request.promise; },
    }));
    t.after(() => previews.forEach((preview) => preview.unmount()));
    assert.deepEqual(started, [], "offscreen previews must not start storage requests");
    assert.equal(environment.observers.length, 6);
    assert.ok(environment.observers.every((observer) => observer.options.rootMargin === "400px"));
    for (const preview of previews) {
        preview.observer!.intersect(true);
        preview.render();
    }
    assert.deepEqual(started, [0, 1, 2, 3], "the fifth and sixth requests must remain queued");
    requests[1].resolve(image("one"));
    await flushAsync();
    assert.deepEqual(started, [0, 1, 2, 3, 4], "one completed request starts exactly one queued load");
    assert.equal(previews[1].render().url, "blob:one");
    assert.equal(previews[1].render().loading, false);
    const failure = new Error("thumbnail unavailable");
    requests[0].reject(failure);
    await flushAsync();
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5], "a rejected request also releases its queue slot");
    assert.equal(previews[0].render().url, "fallback.png");
    assert.equal(previews[0].render().error, failure);
    assert.equal(previews[0].render().loading, false);
    for (const index of [2, 3, 4, 5]) requests[index].resolve(image(String(index)));
    await flushAsync();
    assert.ok(previews.every((preview) => !preview.render().loading));
});

test("leaving the viewport clears the preview and releases its URL once", async (t) => {
    const environment = previewEnvironment();
    const request = deferred<UploadedImage>();
    const preview = environment.mount({ identity: "leave", enabled: true, load: () => request.promise });
    t.after(() => preview.unmount());
    preview.observer!.intersect(true);
    preview.render();
    request.resolve(image("leave"));
    await flushAsync();
    assert.equal(preview.render().url, "blob:leave");
    preview.observer!.intersect(false);
    const hidden = preview.render();
    assert.equal(hidden.url, "");
    assert.equal(hidden.loading, true);
    assert.equal(hidden.error, undefined);
    assert.deepEqual(environment.releases, ["leave"]);
    preview.unmount();
    assert.deepEqual(environment.releases, ["leave"], "unmount must not release an already released URL again");
    assert.equal(preview.observer!.disconnected, true);
});

test("unmount releases a loaded preview and disconnects its observer", async () => {
    const environment = previewEnvironment();
    const preview = environment.mount({ identity: "loaded", enabled: true, load: async () => image("loaded") });
    preview.observer!.intersect(true);
    preview.render();
    await flushAsync();
    assert.equal(preview.render().url, "blob:loaded");
    preview.unmount();
    assert.deepEqual(environment.releases, ["loaded"]);
    assert.equal(preview.observer!.disconnected, true);
});

test("a result arriving after leaving the viewport is released without reviving the hidden preview", async (t) => {
    const environment = previewEnvironment();
    const request = deferred<UploadedImage>();
    const preview = environment.mount({ identity: "late-offscreen", enabled: true, load: () => request.promise });
    t.after(() => preview.unmount());
    preview.observer!.intersect(true);
    preview.render();
    preview.observer!.intersect(false);
    preview.render();
    request.resolve(image("late-offscreen"));
    await flushAsync();
    assert.deepEqual(environment.releases, ["late-offscreen"]);
    assert.equal(preview.render().url, "");
    assert.equal(preview.render().loading, true);
});

test("unmounted queued previews release late results without writing state or blocking subsequent loads", async (t) => {
    const environment = previewEnvironment();
    const requests = Array.from({ length: 6 }, () => deferred<UploadedImage>());
    const started: number[] = [];
    const previews = requests.map((request, index) => environment.mount({
        identity: `queued-${index}`, enabled: true,
        load: () => { started.push(index); return request.promise; },
    }));
    t.after(() => previews.slice(0, 4).concat(previews[5]).forEach((preview) => preview.unmount()));
    for (const preview of previews) { preview.observer!.intersect(true); preview.render(); }
    previews[4].unmount();
    requests[0].resolve(image("first"));
    await flushAsync();
    assert.deepEqual(started, [0, 1, 2, 3, 4]);
    requests[4].resolve(image("cancelled"));
    await flushAsync();
    assert.deepEqual(environment.releases, ["cancelled"]);
    assert.equal(previews[4].postUnmountUpdates, 0);
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
    for (const index of [1, 2, 3, 5]) requests[index].resolve(image(`queued-${index}`));
    await flushAsync();
    assert.equal(previews[5].render().url, "blob:queued-5");
});

test("disabled previews use the fallback without loading, while browsers without an observer can still load", async (t) => {
    const environment = previewEnvironment(false);
    let loads = 0;
    const disabled = environment.mount({ identity: "disabled", enabled: false, fallback: "fallback.png", load: async () => { loads += 1; return image("disabled"); } });
    const enabled = environment.mount({ identity: "enabled", enabled: true, load: async () => { loads += 1; return image("enabled"); } });
    t.after(() => { disabled.unmount(); enabled.unmount(); });
    await flushAsync();
    assert.equal(disabled.render().url, "fallback.png");
    assert.equal(disabled.render().loading, false);
    assert.equal(enabled.render().url, "blob:enabled");
    assert.equal(loads, 1);
});
