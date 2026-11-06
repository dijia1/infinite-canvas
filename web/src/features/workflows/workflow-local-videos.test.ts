import assert from "node:assert/strict";
import test from "node:test";
import { currentVideoBindings, fitWorkflowVideo, localVideoHistory, materializeLocalVideos, pendingRunVideos, replaceWorkflowVideoSize, type LocalVideoOperations } from "./workflow-local-videos";
import { CONFIG_NODE_MIN_SIZE } from "@/lib/canvas-config-card";
import { resizeCanvasNode } from "@/lib/canvas-resize";
import { createWorkflowNode } from "./workflow-graph";
import type { WorkflowGraph } from "./types";

test("video metadata fits a default frame and preserves a user-resized frame", () => {
    const node = { width: 420, height: 236, position: { x: 10, y: 20 } };
    const fitted = fitWorkflowVideo(node, { width: 720, height: 1280 });
    assert.equal(fitted.width / fitted.height, 720 / 1280);
    assert.equal(fitted.position.x + fitted.width / 2, node.position.x + node.width / 2);
    const custom = { ...node, width: 300, height: 500 };
    assert.equal(fitWorkflowVideo(custom, { width: 720, height: 1280 }), custom);
});

test("all config forms resize proportionally against the shared world-space minimum", () => {
    const node = createWorkflowNode("image_generation", { x: 50, y: 60 }, "config");
    assert.deepEqual({ width: node.width, height: node.height }, CONFIG_NODE_MIN_SIZE);
    for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
        const next = resizeCanvasNode({ x: 50, y: 60, width: 720, height: 548, corner, keepRatio: true }, { x: -2000, y: -2000 }, CONFIG_NODE_MIN_SIZE);
        assert.equal(next.width / next.height, 720 / 548);
        assert.ok(next.width >= CONFIG_NODE_MIN_SIZE.width && next.height >= CONFIG_NODE_MIN_SIZE.height);
    }
});

test("pending video checks include the selected frame's external inputs and leave other frames independent", () => {
    const graph: WorkflowGraph = {
        version: 1,
        nodes: [
            { id: "video", type: "video_input", position: { x: 0, y: 0 } },
            { id: "generator", type: "video_generation", position: { x: 500, y: 0 } },
            { id: "other", type: "video_input", position: { x: 1000, y: 0 } },
        ],
        connections: [{ sourceNodeId: "video", sourceSlotId: "output", targetNodeId: "generator", targetPortId: "ref", order: 0 }],
        frames: [{ id: "frame", name: "Frame", position: { x: 400, y: -100 }, width: 600, height: 600, nodeIds: ["generator"] }],
    };
    const operations: LocalVideoOperations = Object.fromEntries(
        ["video", "other"].map((nodeId) => [nodeId, { id: nodeId, nodeId, fileName: nodeId + ".mp4", metadata: { width: 720, height: 1280, duration: 6 }, view: { url: "blob:local", stage: "failed", progress: 70 } }]),
    );
    const bindings = { video: "video", other: "other" };
    assert.deepEqual(
        pendingRunVideos(graph, { type: "frame", frameId: "frame" }, bindings, operations).map((op) => op.nodeId),
        ["video"],
    );
    const history = localVideoHistory({ name: "Flow", graph }, bindings, operations);
    operations.video.remote = { mediaId: "saved", url: "https://media.example/video", bytes: 100, contentType: "video/mp4", width: 720, height: 1280, duration: 6 };
    const restored = materializeLocalVideos(history, operations);
    assert.equal(restored.graph.nodes[0].mediaId, "saved");
    assert.equal(currentVideoBindings(restored.graph, bindings, operations).video, "video");
    assert.equal(pendingRunVideos(restored.graph, { type: "frame", frameId: "frame" }, bindings, operations).length, 0);
});

test("replacement sizing respects frame containment when an adjacent frame blocks expansion", () => {
    const graph: WorkflowGraph = {
        version: 1,
        nodes: [{ id: "video", type: "video_input", position: { x: 50, y: 50 }, width: 200, height: 160 }],
        connections: [],
        frames: [
            { id: "a", name: "A", position: { x: 0, y: 0 }, width: 300, height: 300, nodeIds: ["video"] },
            { id: "b", name: "B", position: { x: 0, y: 310 }, width: 300, height: 300, nodeIds: [] },
        ],
    };
    const next = replaceWorkflowVideoSize(graph, "video", { width: 720, height: 1280, duration: 6 });
    assert.equal(next, graph);
});
