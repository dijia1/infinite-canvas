import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowFinalStep } from "./workflow-drafts";
import { emptyWorkflowGraph, createWorkflowNode } from "./workflow-graph";
import type { VideoGenerationSource } from "@/services/api/video";

const source: VideoGenerationSource = { taskId: "local-sample", providerId: "seedance25", mode: "draft", createdAt: "2026-11-16T00:00:00Z", seconds: 10, size: "9:16", generateAudio: true };
test("formal workflow frame pins the reviewed media and leaves original sample graph intact", () => {
    const sample = createWorkflowNode("video_generation", { x: 0, y: 0 }, "sample");
    sample.config = { videoMode: "draft", providerId: source.providerId };
    const graph = { ...emptyWorkflowGraph(), nodes: [sample] };
    const before = JSON.stringify(graph);
    const result = createWorkflowFinalStep(graph, "sample-from-run-A-slot-B", source);
    assert.equal(JSON.stringify(graph), before);
    const frame = result.graph.frames![0]!;
    assert.equal(frame.id, result.frameId);
    assert.equal(frame.nodeIds.length, 2);
    assert.ok(!frame.nodeIds.includes(sample.id));
    const input = result.graph.nodes.find((n) => n.type === "video_input")!;
    assert.equal(input.mediaId, "sample-from-run-A-slot-B");
    const final = result.graph.nodes.find((n) => n.id === result.nodeId)!;
    assert.equal(final.config?.videoMode, "final");
    assert.equal(final.config?.resolution, "1080p");
    assert.equal(final.config?.seconds, 10);
    assert.deepEqual(
        result.graph.connections.map((c) => [c.sourceNodeId, c.sourceSlotId, c.targetNodeId]),
        [[input.id, "output", final.id]],
    );
    assert.throws(() => createWorkflowFinalStep(result.graph, input.mediaId!, source), /已有正式片/);
});
