import assert from "node:assert/strict";
import test from "node:test";

import { buildNodeGenerationInputs } from "../components/canvas-node-generation";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "../types";
import { captureCanvasClipboard, decodeCanvasClipboard, encodeCanvasClipboard, placeCanvasClipboard, type CanvasClipboardGraph } from "./canvas-node-clipboard";

const node = (id: string, type: CanvasNodeType, metadata?: CanvasNodeMetadata, x = 0): CanvasNodeData =>
    ({ id, type, title: id, position: { x, y: 0 }, width: 100, height: 100, metadata });

test("pasting remaps graph, ordered inputs and masks while keeping media and clearing task handles", () => {
    const graph: CanvasClipboardGraph = {
        nodes: [
            node("a", CanvasNodeType.Image, { mediaId: "media-a", maskId: "source-mask", content: "blob:original", isBatchRoot: true, batchChildIds: ["b", "outside"], primaryImageId: "b", imageTaskId: "old-image-task", imageTaskStatus: "succeeded" }),
            node("b", CanvasNodeType.Image, { mediaId: "media-b", batchRootId: "a", sourceNodeId: "a", maskId: "source-mask" }, 120),
            node("config", CanvasNodeType.Config, { inputOrder: ["b", "outside", "a", "video"], providerOptions: { watermark: false } }, 240),
            node("video", CanvasNodeType.Video, { mediaId: "media-video", videoTaskClientRequestId: "old-client", videoTaskId: "old-video-task", status: "success" }, 360),
            node("outside", CanvasNodeType.Image, { mediaId: "media-outside" }),
        ],
        connections: ["a", "b", "video", "outside"].map(id => ({ id, fromNodeId: id, toNodeId: "config" })),
        maskResources: { "source-mask": { version: 1, strokes: [{ id: "p", tool: "paint", radius: 0.02, points: [{ x: 0.5, y: 0.5 }] }] } },
    };
    const captured = captureCanvasClipboard(graph, new Set(["a", "b", "config", "video"]), () => false).graph;
    const decoded = decodeCanvasClipboard(encodeCanvasClipboard(captured, "owner"), "owner");
    const pasted = placeCanvasClipboard(decoded, { x: 0, y: 0 });
    const [first, second, config, video] = pasted.nodes;

    assert.deepEqual(pasted.nodes.map(node => node.position.x), [-230, -110, 10, 130]);
    assert.ok(pasted.nodes.every((node, index) => node.id !== graph.nodes[index].id));
    assert.equal(first.metadata?.content, undefined);
    assert.equal(first.metadata?.imageTaskId, undefined);
    assert.equal(first.metadata?.imageTaskStatus, undefined);
    assert.equal(video.metadata?.videoTaskId, undefined);
    assert.equal(video.metadata?.videoTaskClientRequestId, undefined);
    assert.deepEqual(config.metadata?.providerOptions, { watermark: false });
    assert.deepEqual(config.metadata?.inputOrder, [second.id, first.id, video.id]);
    assert.deepEqual(first.metadata?.batchChildIds, [second.id]);
    assert.equal(first.metadata?.primaryImageId, second.id);
    assert.equal(second.metadata?.batchRootId, first.id);
    assert.equal(second.metadata?.sourceNodeId, first.id);
    const maskId = first.metadata?.maskId!;
    assert.notEqual(maskId, "source-mask");
    assert.equal(second.metadata?.maskId, maskId);
    assert.deepEqual(pasted.maskResources[maskId], graph.maskResources["source-mask"]);
    assert.deepEqual(buildNodeGenerationInputs(config.id, pasted.nodes, pasted.connections, pasted.maskResources).map(input => input.image?.mediaId || input.video?.mediaId), ["media-b", "media-a", "media-video"]);
    assert.equal(pasted.connections.length, 3);
    assert.notEqual(placeCanvasClipboard(decoded, { x: 0, y: 0 }).nodes[0].id, first.id);
});

test("copy skips incomplete uploads and generations, and a detached result does not inherit a foreign mask", () => {
    const graph: CanvasClipboardGraph = {
        nodes: [
            node("result", CanvasNodeType.Image, { mediaId: "media-result", sourceNodeId: "outside", maskId: "mask", batchRootId: "outside" }),
            node("uploading", CanvasNodeType.Image, { localUploadState: "uploading", storageKey: "image:temp" }),
            node("video-uploading", CanvasNodeType.Video, { mediaId: "old-video" }),
            node("generating", CanvasNodeType.Image, { status: "loading" }),
            node("empty", CanvasNodeType.Image),
        ],
        connections: [{ id: "line", fromNodeId: "generating", toNodeId: "result" }],
        maskResources: { mask: { version: 1, strokes: [{ id: "p", tool: "paint", radius: 0.02, points: [{ x: 0.5, y: 0.5 }] }] } },
    };
    const copied = captureCanvasClipboard(graph, new Set(graph.nodes.map(node => node.id)), id => id === "video-uploading");
    assert.equal(copied.skipped, 3);
    assert.deepEqual(copied.graph.nodes.map(node => node.id), ["result", "empty"]);
    const pasted = placeCanvasClipboard(copied.graph, { x: 0, y: 0 });
    assert.deepEqual(pasted.connections, []);
    assert.deepEqual(pasted.nodes[0].metadata, { mediaId: "media-result" });
    assert.deepEqual(pasted.maskResources, {});
});

test("malformed and cross-account clipboard snapshots are rejected before paste", () => {
    const text = node("text", CanvasNodeType.Text, { content: "copy me" });
    const graph: CanvasClipboardGraph = { nodes: [text], connections: [], maskResources: {} };
    const value = encodeCanvasClipboard(graph, "owner");
    assert.equal(decodeCanvasClipboard(value, "owner").nodes[0].metadata?.content, "copy me");
    assert.throws(() => decodeCanvasClipboard(value, "other"), /复制时的账号/);
    assert.throws(() => decodeCanvasClipboard(encodeCanvasClipboard({ ...graph, nodes: [text, text] }, "owner"), "owner"), /内容无效/);
    assert.throws(() => decodeCanvasClipboard(encodeCanvasClipboard({ ...graph, connections: [{ id: "line", fromNodeId: "text", toNodeId: "missing" }] }, "owner"), "owner"), /内容无效/);
    assert.throws(() => decodeCanvasClipboard("invalid JSON", "owner"), /内容无效/);
});
