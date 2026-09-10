import assert from "node:assert/strict";
import test from "node:test";

import * as runState from "./workflow-run-state";
import type { WorkflowGraph, WorkflowNode, WorkflowOutputExecution, WorkflowRunDetail } from "./types";

const node = (id: string, slotId = "slot"): WorkflowNode => ({ id, type: "image_generation", position: { x: 0, y: 0 }, outputs: [{ id: slotId, type: "image" }] });
const graph = (nodes: WorkflowNode[]): WorkflowGraph => ({ version: 1, nodes, connections: [] });
const output = (nodeId: string, slotId = "slot", runId = "run-1"): WorkflowOutputExecution => ({ runId, nodeId, slotId, status: "succeeded", attempt: 1, mediaId: `${runId}-${nodeId}-${slotId}`, updatedAt: "2026-09-10T00:00:00Z" });

test("compatible output index excludes removed nodes, removed slots and each kind of type change", () => {
    const snapshot = graph([node("kept"), node("removed"), node("slot-removed"), node("mode-changed"), node("slot-changed")]);
    const current = graph([
        snapshot.nodes[0]!,
        { ...snapshot.nodes[2]!, outputs: [] },
        { ...snapshot.nodes[3]!, type: "video_generation" },
        { ...snapshot.nodes[4]!, outputs: [{ id: "slot", type: "video" }] },
        node("new-node"),
    ]);
    const outputs = [...snapshot.nodes.map((item) => output(item.id)), output("new-node"), output("kept", "unknown-slot")];
    const index = runState.indexCompatibleWorkflowOutputs({ graph: snapshot, outputs }, current);
    assert.deepEqual([...index.values()], [outputs[0]]);
    assert.equal(index.get(runState.workflowOutputKey("kept", "slot")), outputs[0]);
    assert.equal(snapshot.nodes[3]!.type, "image_generation");
});

test("output index uses composite identities and preserves first-match result semantics", () => {
    const current = graph([node("a:b", "c"), node("a", "b:c"), node("other", "c")]);
    const first = { ...output("a:b", "c"), status: "failed" as const, mediaId: undefined };
    const duplicate = { ...output("a:b", "c"), attempt: 2 };
    const outputs = [first, output("a", "b:c"), duplicate, output("other", "c")];
    const index = runState.indexCompatibleWorkflowOutputs({ graph: current, outputs }, current);
    assert.equal(index.size, 3);
    assert.equal(index.get(runState.workflowOutputKey("a:b", "c")), first);
    assert.equal(index.get(runState.workflowOutputKey("a", "b:c")), outputs[1]);
    assert.equal(index.get(runState.workflowOutputKey("other", "c")), outputs[3]);
    assert.equal(runState.workflowDownloadImageCount({ graph: current, outputs }), 2);
});

test("rebuilding for a new run, retry response or absent detail cannot retain earlier results", () => {
    const current = graph([node("n")]);
    const first = output("n");
    const before = runState.indexCompatibleWorkflowOutputs({ graph: current, outputs: [first] }, current);
    const retry = { ...first, attempt: 2, status: "running" as const, mediaId: undefined };
    const retryIndex = runState.indexCompatibleWorkflowOutputs({ graph: current, outputs: [retry] }, current);
    const nextRun = output("n", "slot", "run-2");
    const nextIndex = runState.indexCompatibleWorkflowOutputs({ graph: current, outputs: [nextRun] }, current);
    const key = runState.workflowOutputKey("n", "slot");
    assert.equal(before.get(key), first);
    assert.equal(retryIndex.get(key), retry);
    assert.equal(nextIndex.get(key), nextRun);
    assert.equal(runState.workflowDownloadImageCount({ graph: current, outputs: [retry] }), 0);
    assert.equal(runState.indexCompatibleWorkflowOutputs(undefined, current).size, 0);
    assert.equal(runState.indexCompatibleWorkflowOutputs({ graph: current, outputs: [] }, current).size, 0);
    const missingOutputs = { graph: current } as Pick<WorkflowRunDetail, "graph" | "outputs">;
    assert.equal(runState.indexCompatibleWorkflowOutputs(missingOutputs, current).size, 0);
    assert.equal(runState.workflowDownloadImageCount(missingOutputs), 0);
    assert.notEqual(runState.workflowOutputResourceNodeId(first.runId, "n", "slot"), runState.workflowOutputResourceNodeId(nextRun.runId, "n", "slot"));
});

test("download count follows snapshot slots even when the editable graph removes or switches them", () => {
    const snapshot = graph([node("removed"), node("changed"), { ...node("input"), type: "image_input" }]);
    const outputs = snapshot.nodes.map((item) => output(item.id));
    const current = graph([{ ...node("changed"), type: "video_generation", outputs: [{ id: "slot", type: "video" }] }]);
    assert.equal(runState.indexCompatibleWorkflowOutputs({ graph: snapshot, outputs }, current).size, 0);
    assert.equal(runState.workflowDownloadImageCount({ graph: snapshot, outputs }), 2);
});

function countReads<T>(items: T[], increment: () => void): T[] {
    return new Proxy(items, {
        get(target, property, receiver) {
            if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) increment();
            return Reflect.get(target, property, receiver);
        },
    });
}

function largeFixture() {
    const nodes = Array.from({ length: 100 }, (_, index) => ({ ...node(`n-${index}`), outputs: Array.from({ length: 9 }, (_, slot) => ({ id: `s-${slot}`, type: "image" as const })) }));
    const outputs = nodes.flatMap((item) => item.outputs.map((slot) => output(item.id, slot.id)));
    const visits = { snapshotNodes: 0, currentNodes: 0, slots: 0, outputs: 0 };
    const countNodes = (key: "snapshotNodes" | "currentNodes") => countReads(nodes.map((item) => ({ ...item, outputs: countReads(item.outputs, () => visits.slots++) })), () => visits[key]++);
    const current = graph(countNodes("currentNodes"));
    const detail = { graph: graph(countNodes("snapshotNodes")), outputs: countReads(outputs, () => visits.outputs++) };
    return { current, detail, nodes, outputs, visits };
}

test("compatible output index visits large graph arrays linearly for all slot lookups", () => {
    const { current, detail, nodes, outputs, visits } = largeFixture();
    const index = runState.indexCompatibleWorkflowOutputs(detail, current);
    for (const item of nodes) for (const slot of item.outputs) assert.equal(index.get(runState.workflowOutputKey(item.id, slot.id))?.mediaId, `run-1-${item.id}-${slot.id}`);
    assert.equal(index.size, outputs.length);
    assert.ok(visits.outputs <= outputs.length * 2, `output reads: ${visits.outputs}`);
    assert.ok(visits.snapshotNodes + visits.currentNodes <= nodes.length * 4, `node reads: ${visits.snapshotNodes + visits.currentNodes}`);
    assert.ok(visits.slots <= outputs.length * 4, `slot reads: ${visits.slots}`);
});

test("download count visits results linearly instead of scanning once per snapshot slot", () => {
    const { detail, outputs, visits } = largeFixture();
    assert.equal(runState.workflowDownloadImageCount(detail), outputs.length);
    assert.ok(visits.outputs <= outputs.length * 2, `output reads: ${visits.outputs}`);
});
