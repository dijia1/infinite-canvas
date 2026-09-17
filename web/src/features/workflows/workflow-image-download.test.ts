import assert from "node:assert/strict";
import test from "node:test";
import { workflowImageDownloadState, workflowImageMenuSelection } from "./workflow-image-download";
import { workflowVisualNodeId as inputId, workflowVisualOutputId as outputId } from "./workflow-canvas-adapter";
import { indexWorkflowRunOutputsByNode } from "./workflow-run-state";
import type { WorkflowGraph, WorkflowRunDetail } from "./types";

const graph: WorkflowGraph = { version: 1, connections: [], nodes: [
    { id: "input", type: "image_input", mediaId: "original-input", position: { x: 0, y: 0 } },
    { id: "empty", type: "image_input", position: { x: 0, y: 0 } },
    { id: "text", type: "text_input", position: { x: 0, y: 0 } },
    ...["a", "b"].map(id => ({ id, type: "image_generation" as const, position: { x: 100, y: 0 }, outputs: [{ id: "image", type: "image" as const }, { id: "pending", type: "image" as const }, { id: "failed", type: "image" as const }, { id: "video", type: "video" as const }] })),
] };
function detail(nodeId: string): WorkflowRunDetail {
    return { run: { id: `run-${nodeId}` }, graph, outputs: [
        { runId: `run-${nodeId}`, nodeId, slotId: "image", status: "succeeded", mediaId: `original-${nodeId}` },
        { runId: `run-${nodeId}`, nodeId, slotId: "pending", status: "running" },
        { runId: `run-${nodeId}`, nodeId, slotId: "failed", status: "failed", mediaId: "old-failed" },
        { runId: `run-${nodeId}`, nodeId, slotId: "video", status: "succeeded", mediaId: "video" },
    ] } as WorkflowRunDetail;
}

test("right click preserves multi-selection only when the clicked card is selected", () => {
    const selected = new Set([inputId("input"), outputId("a", "image")]);
    assert.deepEqual(workflowImageMenuSelection(selected, inputId("input")), selected);
    assert.deepEqual(workflowImageMenuSelection(selected, outputId("b", "image")), new Set([outputId("b", "image")]));
});

test("downloads only selected inputs and successful compatible outputs across runs", () => {
    const details = new Map([["a", detail("a")], ["b", detail("b")]]);
    const outputs = indexWorkflowRunOutputsByNode(details, graph);
    const selected = new Set([inputId("input"), inputId("empty"), inputId("text"), inputId("a"), ...["a", "b"].flatMap(id => ["image", "pending", "failed", "video"].map(slot => outputId(id, slot)))]);
    const result = workflowImageDownloadState(graph, selected, outputs, { a: "run-a", b: "run-b" }, new Set(["run-a", "run-b"]));
    assert.deepEqual(result.targets.map(t => t.mediaId), ["original-input", "original-a", "original-b"]);
    assert.deepEqual(result.pendingRunIds, []);
    assert.equal(result.pendingOverview, false);
});

test("unloaded selected output waits for its current run instead of silently downloading a subset or old run", () => {
    const selected = new Set([inputId("input"), outputId("a", "image")]);
    const old = indexWorkflowRunOutputsByNode(new Map([["a", detail("a")]]), graph);
    const result = workflowImageDownloadState(graph, selected, old, { a: "new-run" }, new Set(["run-a"]));
    assert.deepEqual(result.pendingRunIds, ["new-run"]);
    assert.deepEqual(result.targets.map(t => t.mediaId), ["original-input"]);
    assert.equal(workflowImageDownloadState(graph, selected, new Map(), undefined, new Set()).pendingOverview, true);
    assert.equal(workflowImageDownloadState(graph, selected, new Map(), {}, new Set()).pendingOverview, false);
});
