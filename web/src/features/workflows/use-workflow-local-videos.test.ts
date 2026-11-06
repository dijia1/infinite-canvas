import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness, sourceModule, deferred } from "@/test-utils/source-component";
import * as transport from "@/features/canvas/media/canvas-local-video-upload-controller";
import * as canvasTypes from "@/features/canvas/types";
import * as drops from "@/features/canvas/utils/canvas-file-drop";
import * as frames from "./workflow-frames";
import * as graphTools from "./workflow-graph";
import * as adapter from "./workflow-canvas-adapter";
import * as local from "./workflow-local-videos";
import type { useWorkflowLocalVideos } from "./use-workflow-local-videos";
import type { WorkflowGraph } from "./types";
import type { VideoMediaAccess, VideoUploadOptions } from "@/services/api/video-media";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const metadata = { width: 720, height: 1280, duration: 6 };
const file = (name = "portrait.mp4") => new File(["local-video-bytes"], name, { type: "video/mp4" });
function fixture(metadataGate?: Promise<typeof metadata>) {
    const h = hookHarness();
    let graph: WorkflowGraph = { version: 1, nodes: [], connections: [] };
    let readOnly = false,
        published = 0,
        key = 0;
    const history: string[] = [];
    const notices: string[] = [],
        revoked: string[] = [];
    const calls: Array<{ options: VideoUploadOptions; gate: ReturnType<typeof deferred<VideoMediaAccess>> }> = [];
    const { useWorkflowLocalVideos: useHook } = sourceModule<{ useWorkflowLocalVideos: typeof useWorkflowLocalVideos }>(
        new URL("./use-workflow-local-videos.ts", import.meta.url),
        {
            react: h.hooks,
            nanoid: { nanoid: () => `id-${++key}` },
            "@/services/api/video-media": {
                prepareVideoUpload: async (_file: File, signal: AbortSignal) => {
                    signal.throwIfAborted();
                    return metadataGate || metadata;
                },
            },
            "@/features/canvas/media/canvas-local-video-upload-controller": {
                createCanvasLocalVideoUploadController: (options: Parameters<typeof transport.createCanvasLocalVideoUploadController>[0]) =>
                    transport.createCanvasLocalVideoUploadController({
                        ...options,
                        upload: async (_file, options = {}) => {
                            const gate = deferred<VideoMediaAccess>();
                            calls.push({ options, gate });
                            return gate.promise;
                        },
                    }),
            },
            "@/features/canvas/types": canvasTypes,
            "@/features/canvas/utils/canvas-file-drop": drops,
            "./workflow-frames": frames,
            "./workflow-graph": graphTools,
            "./workflow-canvas-adapter": adapter,
            "./workflow-local-videos": local,
        },
        {
            window: { addEventListener() {}, removeEventListener() {} },
            URL: { createObjectURL: () => `blob:preview-${++key}`, revokeObjectURL: (url: string) => revoked.push(url) },
        },
    );
    const render = () =>
        h.render(() =>
            useHook({
                document: { name: "Flow", graph },
                ready: true,
                readOnly,
                setGraph: (update) => {
                    graph = typeof update === "function" ? update(graph) : update;
                },
                onSelected() {},
                notify: (text) => notices.push(text),
                onUploaded: () => published++,
                beforeEdit() {},
                retainedHistory: () => history,
            }),
        );
    let hook = render();
    return {
        calls,
        notices,
        revoked,
        get graph() {
            return graph;
        },
        get hook() {
            return hook;
        },
        get published() {
            return published;
        },
        render: () => {
            hook = render();
        },
        graphChanged: (next: WorkflowGraph) => {
            graph = next;
            hook = render();
        },
        readonly: () => {
            readOnly = true;
            hook = render();
        },
        unmount: () => h.unmount(),
        retain: (snapshot: string) => history.push(snapshot),
        get postUnmountUpdates() {
            return h.postUnmountUpdates;
        },
    };
}
const result = (mediaId = "remote") => ({ mediaId, url: "https://media.example/video", contentType: "video/mp4", bytes: 100, ...metadata });

test("portrait preview has its final ratio before upload, and progress never enters the graph", async () => {
    const f = fixture();
    await f.hook.importFiles([file()], { x: 600, y: 500 });
    f.render();
    const node = f.graph.nodes[0],
        id = node.id;
    assert.equal(node.width! / node.height!, 720 / 1280);
    assert.deepEqual({ x: node.position.x + node.width! / 2, y: node.position.y + node.height! / 2 }, { x: 600, y: 500 });
    assert.ok(f.hook.get(id)?.url.startsWith("blob:"));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].options.metadata, metadata);
    f.calls[0].options.onProgress?.(42);
    f.render();
    assert.equal(f.hook.get(id)?.progress, 42);
    assert.equal(f.hook.pending({ type: "workflow" }).length, 1);
    assert.doesNotMatch(JSON.stringify(f.graph), /blob:|local-video-bytes|progress/);
    f.graphChanged({ ...f.graph, nodes: [{ ...node, position: { x: 999, y: 55 } }] });
    f.calls[0].gate.resolve(result());
    await tick();
    f.render();
    assert.equal(f.graph.nodes[0].mediaId, "remote");
    assert.deepEqual(f.graph.nodes[0].position, { x: 999, y: 55 });
    assert.equal(f.hook.pending({ type: "workflow" }).length, 0);
    assert.equal(f.published, 1);
    f.unmount();
    assert.equal(f.postUnmountUpdates, 0);
});

for (const end of ["delete", "undo", "readonly", "unmount"] as const)
    test(`${end} stops pending upload and rejects its late result`, async () => {
        const f = fixture();
        const before = f.hook.snapshot({ name: "Flow", graph: f.graph });
        await f.hook.importFiles([file()], { x: 0, y: 0 });
        f.render();
        if (end === "delete") f.graphChanged({ ...f.graph, nodes: [] });
        if (end === "undo") f.graphChanged(f.hook.applyHistory(before).graph);
        if (end === "readonly") f.readonly();
        if (end === "unmount") f.unmount();
        assert.equal(f.calls[0].options.signal?.aborted, true);
        f.calls[0].gate.resolve(result("late"));
        await tick();
        if (end !== "unmount") f.render();
        assert.notEqual(f.graph.nodes[0]?.mediaId, "late");
        assert.equal(f.published, 0);
        if (end !== "unmount") f.unmount();
        assert.equal(f.postUnmountUpdates, 0);
    });

test("retry confirms the original uploaded intent, and cancelling replacement restores its old size", async () => {
    const f = fixture();
    f.graphChanged({ ...f.graph, nodes: [{ id: "video", type: "video_input", mediaId: "original", position: { x: 10, y: 20 }, width: 300, height: 200 }] });
    await f.hook.importFiles([file()], { x: 0, y: 0 }, "video");
    f.render();
    f.calls[0].options.onUploaded?.("uploaded-once");
    f.calls[0].gate.reject(Error("confirmation unavailable"));
    await tick();
    f.render();
    assert.equal(f.hook.get("video")?.stage, "failed");
    f.hook.retry("video");
    f.render();
    assert.equal(f.calls[1].options.uploadedIntentId, "uploaded-once");
    f.hook.cancel("video");
    f.render();
    assert.deepEqual(f.graph.nodes[0], { id: "video", type: "video_input", mediaId: "original", position: { x: 10, y: 20 }, width: 300, height: 200 });
    f.calls[1].gate.resolve(result("late"));
    await tick();
    f.render();
    assert.equal(f.graph.nodes[0].mediaId, "original");
    f.unmount();
});

test("redo of a completed upload reuses its media ID without uploading again", async () => {
    const f = fixture();
    await f.hook.importFiles([file()], { x: 0, y: 0 });
    f.render();
    f.calls[0].gate.resolve(result());
    await tick();
    f.render();
    const snapshot = f.hook.snapshot({ name: "Flow", graph: f.graph });
    f.retain(snapshot);
    assert.doesNotMatch(snapshot, /blob:|local-video-bytes/);
    f.graphChanged({ ...f.graph, nodes: [] });
    f.graphChanged(f.hook.applyHistory(snapshot).graph);
    await tick();
    f.render();
    assert.equal(f.graph.nodes[0].mediaId, "remote");
    assert.equal(f.calls.length, 1);
    f.unmount();
});

test("metadata preparation blocks only the frame using the replaced video", async () => {
    const gate = deferred<typeof metadata>();
    const f = fixture(gate.promise);
    f.graphChanged({
        version: 1,
        nodes: [{ id: "video", type: "video_input", mediaId: "original", position: { x: 0, y: 0 } }],
        connections: [],
        frames: [
            { id: "uses-video", name: "A", position: { x: 0, y: 0 }, width: 500, height: 500, nodeIds: ["video"] },
            { id: "unrelated", name: "B", position: { x: 600, y: 0 }, width: 500, height: 500, nodeIds: [] },
        ],
    });
    const importing = f.hook.importFiles([file()], { x: 0, y: 0 }, "video");
    assert.equal(f.hook.pending({ type: "frame", frameId: "uses-video" }).length, 1);
    assert.equal(f.hook.pending({ type: "frame", frameId: "unrelated" }).length, 0);
    gate.resolve(metadata);
    await importing;
    f.render();
    f.unmount();
});

test("replacement still uploads when adjacent frames prevent a size change", async () => {
    const f = fixture();
    f.graphChanged({
        version: 1,
        nodes: [{ id: "video", type: "video_input", mediaId: "original", position: { x: 50, y: 50 }, width: 200, height: 160 }],
        connections: [],
        frames: [
            { id: "a", name: "A", position: { x: 0, y: 0 }, width: 300, height: 300, nodeIds: ["video"] },
            { id: "b", name: "B", position: { x: 0, y: 310 }, width: 300, height: 300, nodeIds: [] },
        ],
    });
    const before = f.graph;
    await f.hook.importFiles([file()], { x: 0, y: 0 }, "video");
    f.render();
    assert.equal(f.graph, before);
    assert.equal(f.calls.length, 1);
    f.calls[0].gate.resolve(result("replacement"));
    await tick();
    f.render();
    assert.equal(f.graph.nodes[0].mediaId, "replacement");
    assert.deepEqual({ width: f.graph.nodes[0].width, height: f.graph.nodes[0].height }, { width: 200, height: 160 });
    f.unmount();
});
