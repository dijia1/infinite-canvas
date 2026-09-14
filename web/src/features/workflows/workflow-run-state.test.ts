import assert from "node:assert/strict";
import test from "node:test";

import { findCompatibleWorkflowOutput, findWorkflowOutput, indexWorkflowRunDetailsByNode, isRetryableImageOutput, isWorkflowRunActive, latestWorkflowRun, workflowOutputKey, workflowOutputResourceNodeId, workflowRunScopeLabel, workflowRunStatusText, workflowVideoResumeTaskID } from "./workflow-run-state";
import type { WorkflowGraph, WorkflowOutputExecution, WorkflowOutputSlot, WorkflowRun, WorkflowRunDetail } from "./types";

const run = (id: string, workflowId: string, status: WorkflowRun["status"], createdAt: string): WorkflowRun => ({ id, workflowId, status, createdAt, updatedAt: createdAt, requestId: `${id}-request`, revision: 1, title: id, scopeType: "workflow", frameId: "", frameName: "", stopRequested: false });
const output = (status: WorkflowOutputExecution["status"]): WorkflowOutputExecution => ({ runId: "run-1", nodeId: "node-1", slotId: "slot-1", status, attempt: 1, updatedAt: "2026-09-09T00:00:00Z" });

test("classifies open runs and explains uncertain recovery", () => {
    for (const status of ["pending", "running", "stopping", "attention_required"] as const) assert.equal(isWorkflowRunActive(status), true);
    for (const status of ["completed", "partially_completed", "failed", "stopped"] as const) assert.equal(isWorkflowRunActive(status), false);
    assert.match(workflowRunStatusText("attention_required"), /需要确认/);
});

test("offers original-task resume only for an uncertain video output with its persisted task ID", () => {
    const detail = {
        run: run("run-1", "workflow-1", "attention_required", "2026-09-09T00:00:00Z"),
        graph: {
            version: 1,
            nodes: [
                { id: "video", type: "video_generation", position: { x: 0, y: 0 }, outputs: [{ id: "output", type: "video" }] },
                { id: "image", type: "image_generation", position: { x: 0, y: 0 }, outputs: [{ id: "output", type: "image" }] },
            ],
            connections: [],
        },
        steps: [],
        outputs: [
            { runId: "run-1", nodeId: "video", slotId: "output", status: "uncertain", attempt: 2, updatedAt: "2026-09-09T00:00:01Z" },
            { runId: "run-1", nodeId: "image", slotId: "output", status: "uncertain", attempt: 1, updatedAt: "2026-09-09T00:00:01Z" },
        ],
        attempts: [
            { id: "attempt-video-old", runId: "run-1", nodeId: "video", slotId: "output", attempt: 1, requestId: "request-old", taskType: "video", taskId: "old-video-task", status: "failed", createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z" },
            { id: "attempt-video", runId: "run-1", nodeId: "video", slotId: "output", attempt: 2, requestId: "request-video", taskType: "video", taskId: "original-video-task", status: "uncertain", createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:01Z" },
            { id: "attempt-image", runId: "run-1", nodeId: "image", slotId: "output", attempt: 1, requestId: "request-image", taskType: "image", taskId: "image-task", status: "uncertain", createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:01Z" },
        ],
    } satisfies WorkflowRunDetail;

    assert.equal(workflowVideoResumeTaskID(detail, detail.outputs[0]), "original-video-task");
    assert.equal(workflowVideoResumeTaskID(detail, detail.outputs[1]), undefined);
    assert.equal(workflowVideoResumeTaskID({ ...detail, run: { ...detail.run, status: "running" } }, detail.outputs[0]), undefined);
    assert.equal(workflowVideoResumeTaskID({ ...detail, attempts: detail.attempts.filter((attempt) => attempt.attempt === 1) }, detail.outputs[0]), undefined);
});

test("labels run history from its immutable scope snapshot", () => {
    assert.equal(workflowRunScopeLabel({ scopeType: "workflow", frameName: "" }), "整个流程");
    assert.equal(workflowRunScopeLabel({ scopeType: "frame", frameName: "二次元分支" }), "二次元分支");
    assert.equal(workflowRunScopeLabel({ scopeType: "frame", frameName: "" }), "包裹框");
});

test("selects the latest run for one workflow without mixing deleted definitions", () => {
    const items = [run("other", "workflow-2", "running", "2026-09-09T03:00:00Z"), run("new", "workflow-1", "failed", "2026-09-09T02:00:00Z"), run("old", "workflow-1", "completed", "2026-09-09T01:00:00Z")];
    assert.equal(latestWorkflowRun(items, "workflow-1")?.id, "new");
    assert.equal(latestWorkflowRun(items, "missing"), undefined);
});

test("identifies outputs by node and slot and only retries failed image outputs", () => {
    const outputs = [output("failed"), { ...output("succeeded"), nodeId: "node-2" }];
    assert.equal(workflowOutputKey("node-1", "slot-1"), JSON.stringify(["node-1", "slot-1"]));
    assert.equal(findWorkflowOutput(outputs, "node-2", "slot-1")?.status, "succeeded");
    const image: WorkflowOutputSlot = { id: "slot-1", type: "image" };
    const video: WorkflowOutputSlot = { id: "slot-1", type: "video" };
    assert.equal(isRetryableImageOutput(image, output("failed"), run("run-1", "workflow-1", "failed", "2026-09-09T00:00:00Z")), true);
    assert.equal(isRetryableImageOutput(video, output("failed"), run("run-1", "workflow-1", "failed", "2026-09-09T00:00:00Z")), false);
    assert.equal(isRetryableImageOutput(image, output("uncertain"), run("run-1", "workflow-1", "attention_required", "2026-09-09T00:00:00Z")), false);
    assert.equal(isRetryableImageOutput(image, output("failed"), { ...run("run-1", "workflow-1", "stopped", "2026-09-09T00:00:00Z"), stopRequested: true }), false);
});

test("keeps legal identifiers with colons collision free", () => {
    assert.notEqual(workflowOutputKey("a:b", "c"), workflowOutputKey("a", "b:c"));
    assert.notEqual(workflowOutputResourceNodeId("run", "a:b", "c"), workflowOutputResourceNodeId("run", "a", "b:c"));
});


test("mode switching cannot render an old image result as video", () => {
    const graph: WorkflowGraph = { version: 1, nodes: [{ id: "node-1", type: "image_generation", position: {x:0,y:0}, inputPorts: [], outputs: [{id:"slot-1",type:"image"}] }], connections: [] };
    const result = { graph, outputs: [output("succeeded")] };
    assert.equal(findCompatibleWorkflowOutput(result, graph, "node-1", "slot-1")?.status, "succeeded");
    const changed: WorkflowGraph = { ...graph, nodes: [{ ...graph.nodes[0], type:"video_generation", outputs:[{id:"slot-1",type:"video"}] }] };
    assert.equal(findCompatibleWorkflowOutput(result, changed, "node-1", "slot-1"), undefined);
    assert.equal(result.outputs[0].status, "succeeded");
});

test("download counts successful image slots from run snapshot, excluding inputs and old attempts", async () => {
    const { workflowDownloadImageCount } = await import("./workflow-run-state");
    const detail = {
        graph: { version: 1, nodes: [
            { id: "input", type: "image_input", mediaId: "input", position: { x: 0, y: 0 } },
            { id: "gen", type: "image_generation", position: { x: 0, y: 0 }, outputs: [{ id: "ok", type: "image" }, { id: "failed", type: "image" }, { id: "loading", type: "image" }] },
            { id: "video", type: "video_generation", position: { x: 0, y: 0 }, outputs: [{ id: "ok", type: "video" }] },
        ], connections: [] },
        outputs: [
            { nodeId: "gen", slotId: "ok", status: "succeeded", mediaId: "latest" },
            { nodeId: "gen", slotId: "failed", status: "failed", mediaId: "old" },
            { nodeId: "gen", slotId: "loading", status: "running" },
            { nodeId: "video", slotId: "ok", status: "succeeded", mediaId: "video" },
        ],
    } as unknown as Parameters<typeof workflowDownloadImageCount>[0];
    assert.equal(workflowDownloadImageCount(detail), 1);
    assert.equal(workflowDownloadImageCount(undefined), 0);
});

test("indexes each node from the exact server-selected run regardless of detail arrival order", () => {
    const detail = (nodeId: string, runId: string, slotType: "image" | "video" = "image") => ({
        run: { ...run(runId, "workflow", "completed", "2026-09-11T00:00:00Z"), scopeType: "frame" as const, frameId: `frame-${nodeId}`, frameName: nodeId },
        graph: { version: 1 as const, nodes: [{ id: nodeId, type: slotType === "image" ? "image_generation" as const : "video_generation" as const, position: { x: 0, y: 0 }, outputs: [{ id: "out", type: slotType }] }], connections: [] },
        steps: [], attempts: [], outputs: [{ runId, nodeId, slotId: "out", status: "succeeded" as const, attempt: 1, mediaId: `media-${runId}`, updatedAt: "2026-09-11T00:00:01Z" }],
    });
    const a = detail("a", "run-a");
    const b = detail("b", "run-b");
    const graph: WorkflowGraph = { version: 1, nodes: [...a.graph.nodes, ...b.graph.nodes], connections: [] };
    for (const details of [new Map([["run-a", a], ["run-b", b]]), new Map([["run-b", b], ["run-a", a]])]) {
        const indexed = indexWorkflowRunDetailsByNode(details, { a: "run-a", b: "run-b" }, graph);
        assert.equal(indexed.get("a")?.run.id, "run-a");
        assert.equal(indexed.get("b")?.run.id, "run-b");
    }
});

test("never falls back to an older detail while the selected source is missing or incompatible", () => {
    const old = {
        run: { ...run("run-old", "workflow", "completed", "2026-09-11T00:00:00Z"), scopeType: "frame" as const, frameId: "frame", frameName: "Frame" },
        graph: { version: 1 as const, nodes: [{ id: "node", type: "image_generation" as const, position: { x: 0, y: 0 }, outputs: [{ id: "out", type: "image" as const }] }], connections: [] },
        steps: [], attempts: [], outputs: [{ runId: "run-old", nodeId: "node", slotId: "out", status: "succeeded" as const, attempt: 1, mediaId: "old", updatedAt: "2026-09-11T00:00:01Z" }],
    };
    const graph = old.graph;
    assert.equal(indexWorkflowRunDetailsByNode(new Map([["run-old", old]]), { node: "run-new" }, graph).has("node"), false);
    const incompatible = { ...old, run: { ...old.run, id: "run-new" }, graph: { ...old.graph, nodes: [{ ...old.graph.nodes[0], type: "video_generation" as const, outputs: [{ id: "out", type: "video" as const }] }] } };
    assert.equal(indexWorkflowRunDetailsByNode(new Map([["run-new", incompatible]]), { node: "run-new" }, graph).has("node"), false);
});
