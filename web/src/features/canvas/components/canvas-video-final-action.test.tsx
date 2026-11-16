import assert from "node:assert/strict";
import test from "node:test";
import { canvasThemes } from "@/lib/canvas-theme";
import type { VideoGenerationSource } from "@/services/api/video";
import type { VideoMediaAccess } from "@/services/api/video-media";
import { deferred, elements, flushAsync, hookHarness, oneElement, sourceModule, type TestElement } from "@/test-utils/source-component";
import { createVideoResourceManager } from "../media/video-resource-manager";
import type { CanvasVideoContent, CanvasVideoFinalAction } from "./canvas-video-content";

const draft: VideoGenerationSource = { taskId: "verified-draft-task", providerId: "seedance25", mode: "draft", createdAt: "2026-11-16T00:00:00Z", seconds: 5, size: "16:9", generateAudio: true };
const access = (mediaId: string, generation: VideoGenerationSource | undefined = draft): VideoMediaAccess => ({ mediaId, url: "/sample.mp4", contentType: "video/mp4", width: 640, height: 360, bytes: 100, duration: 5, expiresAt: "2099-01-01T00:00:00Z", videoGeneration: generation });

function setup(loadAccess = async (id: string) => access(id), onGenerateFinal?: (nodeId: string, source: VideoGenerationSource, mediaId: string) => void | Promise<void>) {
    const h = hookHarness();
    const resources = { manager: createVideoResourceManager({ loadAccess }), playback: new Map(), onGenerateFinal, finalActionLabel: "创建正式片步骤" };
    const react = { ...h.hooks, useLayoutEffect: h.hooks.useEffect, createContext: () => ({}), useContext: () => resources };
    const components = sourceModule<{ CanvasVideoFinalAction: typeof CanvasVideoFinalAction; CanvasVideoContent: typeof CanvasVideoContent }>(new URL("./canvas-video-content.tsx", import.meta.url), {
        react,
        "../media/video-resource-manager": { createVideoResourceManager: () => resources.manager },
        "../stores/use-canvas-store": { useCanvasStore: () => undefined },
    }, { document: { addEventListener() {}, removeEventListener() {} } });
    const render = (mediaId = "draft") => h.render(() => components.CanvasVideoFinalAction({ nodeId: mediaId, mediaId, theme: canvasThemes.dark }));
    const close = () => { h.unmount(); resources.manager.dispose(); };
    return { ...components, h, react, resources, render, close };
}

test("result action uses the player's cached verified source and stays absent for ordinary/final/read-only videos", async () => {
    let reads = 0;
    const s = setup(async id => {
        reads++;
        return access(id, id === "ordinary" ? { ...draft, mode: "" } : id === "final" ? { ...draft, mode: "final" } : draft);
    }, () => {});
    const player = s.resources.manager.acquire("draft");
    await player.getAccess();
    assert.equal(s.render(), null);
    await flushAsync();
    const action = s.render() as TestElement;
    assert.equal(action.props.source.taskId, draft.taskId);
    assert.equal(action.props.source.providerId, draft.providerId);
    assert.equal(reads, 1, "panel must reuse cached player access");
    for (const id of ["ordinary", "final"]) {
        assert.equal(s.render(id), null, "previous draft is never displayed during a media switch");
        await flushAsync();
        assert.equal(s.render(id), null);
    }
    player.release();
    s.close();
    const readOnly = setup(async id => { throw new Error(`unexpected access: ${id}`); });
    assert.equal(readOnly.render(), null);
    await flushAsync();
    assert.equal(readOnly.render(), null);
    readOnly.close();
});

test("late metadata and metadata errors cannot leak into a different result panel", async () => {
    const old = deferred<VideoMediaAccess>();
    const s = setup(id => id === "old" ? old.promise : Promise.resolve(access(id, { ...draft, mode: "final" })), () => {});
    s.render("old");
    s.render("new");
    old.resolve(access("old"));
    await flushAsync();
    assert.equal(s.render("new"), null);
    s.close();
    let reads = 0;
    const retry = setup(async id => { if (++reads === 1) throw new Error("读取样片失败"); return access(id); }, () => {});
    retry.render(); await flushAsync();
    const error = retry.render();
    assert.equal(oneElement(error, "span").props.role, "alert");
    oneElement(error, "button").props.onClick();
    assert.equal(retry.render(), null);
    await flushAsync();
    assert.equal((retry.render() as TestElement).props.source.taskId, draft.taskId);
    retry.close();
});

test("formal action locks repeated clicks, reports errors and keeps a submitted operation alive after panel closes", async () => {
    const requests: unknown[][] = [];
    const submission = deferred<void>();
    const s = setup(undefined, (...args) => { requests.push(args); return submission.promise; });
    s.render(); await flushAsync();
    const action = s.render() as TestElement;
    s.h.unmount();
    const buttonHooks = hookHarness();
    Object.assign(s.react, buttonHooks.hooks);
    const Button = action.type as (props: typeof action.props) => unknown;
    let buttonProps = { ...action.props };
    const renderButton = () => buttonHooks.render(() => Button(buttonProps));
    const click = oneElement(renderButton(), "button").props.onClick;
    const first = click();
    await click();
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], ["draft", action.props.source, "draft"]);
    assert.equal(oneElement(renderButton(), "button").props.disabled, true);
    submission.reject(new Error("供应商暂不可用"));
    await first;
    assert.equal(oneElement(renderButton(), "span").props.role, "alert");
    assert.equal(oneElement(renderButton(), "span").props.children, "供应商暂不可用");
    const continuing = deferred<void>();
    buttonProps = { ...buttonProps, onGenerate: () => continuing.promise };
    const again = oneElement(renderButton(), "button").props.onClick();
    assert.equal(elements(renderButton(), e => e.props.role === "alert").length, 0);
    buttonHooks.unmount();
    continuing.resolve();
    await again;
    assert.equal(buttonHooks.postUnmountUpdates, 0);
    s.resources.manager.dispose();
});

test("player footer remains enabled by default for workflows and is removable without replacing the native player", async () => {
    const s = setup(undefined, () => {});
    const render = (showGenerationFooter?: boolean) => s.h.render(() => s.CanvasVideoContent({ nodeId: "video", mediaId: "draft", showGenerationFooter }));
    render(); await flushAsync();
    const old = render();
    assert.equal(elements(old, e => e.type === "span" && e.props.children === "样片 · 480p").length, 1);
    assert.equal(elements(old, e => e.props.label === "创建正式片步骤").length, 1);
    const player = oneElement(old, "video");
    const clean = render(false);
    assert.equal(elements(clean, e => e.type === "span").length, 0);
    assert.equal(elements(clean, e => e.props.label === "创建正式片步骤").length, 0);
    assert.equal(oneElement(clean, "video").props.ref, player.props.ref);
    assert.equal(oneElement(clean, "video").props.src, player.props.src);
    assert.equal(oneElement(clean, "video").props.controls, true);
    s.close();
});
