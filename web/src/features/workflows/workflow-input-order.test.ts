import test from "node:test";
import assert from "node:assert/strict";
import { reorderWorkflowImageInputs } from "./workflow-graph";
import type { WorkflowGraph } from "./types";

test("reordering images preserves other input positions, duplicate assets and output-port identities", () => {
    const graph: WorkflowGraph = {
        version: 1,
        nodes: [
            { id: "a", type: "image_input", mediaId: "same", position: { x: 0, y: 0 } },
            { id: "b", type: "image_input", mediaId: "same", position: { x: 0, y: 0 } },
            { id: "c", type: "image_generation", position: { x: 0, y: 0 }, outputs: [{ id: "result", type: "image" }] },
            { id: "text", type: "text_input", text: "把图1放在图2上", position: { x: 0, y: 0 } },
            { id: "video", type: "video_input", position: { x: 0, y: 0 } },
            { id: "target", type: "video_generation", position: { x: 0, y: 0 } },
        ],
        connections: ["a", "text", "b", "video", "c"].map((id, order) => ({ sourceNodeId: id, sourceSlotId: id === "c" ? "result" : "output", targetNodeId: "target", targetPortId: `port-${id}`, order })),
    };
    const before = structuredClone(graph);
    const next = reorderWorkflowImageInputs(graph, "target", ["port-c", "port-a", "port-b"]);
    const sorted = [...next.connections].sort((a, b) => a.order - b.order);
    assert.deepEqual(sorted.map(edge => edge.sourceNodeId), ["c", "text", "a", "video", "b"]);
    assert.deepEqual(next.connections.map(({ order, ...edge }) => edge), graph.connections.map(({ order, ...edge }) => edge));
    assert.equal(next.nodes, graph.nodes);
    assert.deepEqual(graph, before);
    const saved: WorkflowGraph = JSON.parse(JSON.stringify(next));
    assert.deepEqual(saved.connections.sort((a, b) => a.order - b.order).map(edge => edge.targetPortId), ["port-c", "port-text", "port-a", "port-video", "port-b"]);
    assert.equal(reorderWorkflowImageInputs(next, "target", ["port-c", "port-a", "port-b"]), next);
});
