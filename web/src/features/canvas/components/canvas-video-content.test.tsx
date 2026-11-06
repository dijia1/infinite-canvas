import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { hookHarness, sourceModule } from "@/test-utils/source-component";
import { CanvasVideoContent } from "./canvas-video-content";
test("visible video exposes native controls without preloading or a central play button", () => {
    const html = renderToStaticMarkup(<CanvasVideoContent nodeId="v" mediaId="m" />);
    assert.match(html, /<video/);
    assert.match(html, /controls=""/);
    assert.match(html, /preload="none"/);
    assert.match(html, /data-video-drag-surface/);
    assert.doesNotMatch(html, /<button|播放视频/);
});
test("offscreen unused video does not initialize a player", () => {
    const html = renderToStaticMarkup(<CanvasVideoContent nodeId="v" mediaId="m" visible={false} />);
    assert.doesNotMatch(html, /<video/);
});

test("metadata read before editing permission is delivered when layout updates become available", async () => {
    const h = hookHarness();
    const sizes: Array<{ width: number; height: number }> = [];
    let reads = 0;
    const resources = { playback: new Map(), manager: { acquire: () => ({
        getAccess: async () => { reads++; return { url: "video-url", width: 180, height: 320 }; },
        getPoster: async () => undefined, release() {},
    }) } };
    const { CanvasVideoContent: Video } = sourceModule<{ CanvasVideoContent: typeof CanvasVideoContent }>(new URL("./canvas-video-content.tsx", import.meta.url), {
        react: { ...h.hooks, useLayoutEffect: h.hooks.useEffect, createContext: () => ({}), useContext: () => resources },
        "../media/video-resource-manager": { createVideoResourceManager: () => resources.manager },
        "../stores/use-canvas-store": { useCanvasStore: () => undefined },
    }, { document: { addEventListener() {}, removeEventListener() {} } });
    const render = (enabled: boolean) => h.render(() => Video({ nodeId: "v", mediaId: "media", onDimensions: enabled ? value => sizes.push(value) : undefined }));
    render(false); await new Promise(resolve => setTimeout(resolve, 0)); render(false);
    assert.deepEqual(sizes, []);
    assert.equal(reads, 1);
    render(true);
    assert.deepEqual(sizes, [{ width: 180, height: 320 }]);
    render(true);
    assert.equal(sizes.length, 1);
    assert.equal(reads, 1);
    h.unmount();
});


test("missing generated-video dimensions are read from the cached poster without loading video metadata", async () => {
    const h = hookHarness();
    const sizes: Array<{ width: number; height: number }> = [];
    const posterReads: string[] = [];
    let reads = 0;
    const resources = { playback: new Map(), manager: { acquire: () => ({
        getAccess: async () => { reads++; return { url: "video-url", width: 0, height: 0 }; },
        getPoster: async () => "blob:cached-poster", release() {},
    }) } };
    class PosterImage {
        naturalWidth = 180;
        naturalHeight = 320;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(value: string) { posterReads.push(value); queueMicrotask(() => this.onload?.()); }
        removeAttribute() {}
    }
    const { CanvasVideoContent: Video } = sourceModule<{ CanvasVideoContent: typeof CanvasVideoContent }>(new URL("./canvas-video-content.tsx", import.meta.url), {
        react: { ...h.hooks, useLayoutEffect: h.hooks.useEffect, createContext: () => ({}), useContext: () => resources },
        "../media/video-resource-manager": { createVideoResourceManager: () => resources.manager },
        "../stores/use-canvas-store": { useCanvasStore: () => undefined },
    }, { Image: PosterImage, document: { addEventListener() {}, removeEventListener() {} } });
    const render = () => h.render(() => Video({ nodeId: "v", mediaId: "generated", onDimensions: value => sizes.push(value) }));
    for (let pass = 0; pass < 5; pass++) {
        render();
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.deepEqual(sizes, [{ width: 180, height: 320 }]);
    assert.deepEqual([...new Set(posterReads)], ["blob:cached-poster"]);
    assert.ok(reads > 0);
    h.unmount();
});
