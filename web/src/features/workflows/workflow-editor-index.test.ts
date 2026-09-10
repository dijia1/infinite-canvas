import assert from "node:assert/strict";
import test from "node:test";

import { sourceBehavior } from "@/test-utils/source-behavior";
import { hookHarness, sourceModule } from "../../test-utils/source-component";
import * as adapter from "./workflow-canvas-adapter";
import * as workflowGraph from "./workflow-graph";
import * as runState from "./workflow-run-state";
import type { useWorkflowInteractions } from "./use-workflow-interactions";
import type { WorkflowConnection, WorkflowGraph, WorkflowNode, WorkflowOutputExecution } from "./types";

const editorURL = new URL("./workflow-editor.tsx", import.meta.url);
const interactionsURL = new URL("./use-workflow-interactions.ts", import.meta.url);

test("editor output memos refresh on run data and graph changes without mixing download snapshot scope", () => {
    const harness = hookHarness();
    const graph: WorkflowGraph = { version: 1, nodes: [workflowGraph.createWorkflowNode("image_generation", { x: 0, y: 0 }, "node")], connections: [] };
    const slotId = graph.nodes[0]!.outputs![0]!.id;
    const first: WorkflowOutputExecution = { runId: "run-1", nodeId: "node", slotId, status: "succeeded", attempt: 1, mediaId: "first", updatedAt: "now" };
    const detail = { graph, outputs: [first] };
    const render = (data: typeof detail | undefined, currentGraph = graph) => harness.render(() => {
        const production = sourceBehavior(editorURL, { useMemo: harness.hooks.useMemo, currentRun: { data }, graph: currentGraph, indexCompatibleWorkflowOutputs: runState.indexCompatibleWorkflowOutputs, workflowDownloadImageCount: runState.workflowDownloadImageCount });
        return { outputs: production.named("compatibleOutputs") as Map<string, WorkflowOutputExecution>, count: production.named("downloadImageCount") as number };
    });
    const initial = render(detail);
    assert.equal(render(detail).outputs, initial.outputs);
    assert.equal(initial.count, 1);
    const retry = render({ graph, outputs: [{ ...first, attempt: 2, status: "running", mediaId: undefined }] });
    assert.equal(retry.outputs.get(runState.workflowOutputKey("node", slotId))?.attempt, 2);
    assert.equal(retry.count, 0);
    const nextRun = { graph, outputs: [{ ...first, runId: "run-2", mediaId: "second" }] };
    const next = render(nextRun);
    assert.equal(next.outputs.get(runState.workflowOutputKey("node", slotId))?.runId, "run-2");
    assert.equal(initial.outputs.get(runState.workflowOutputKey("node", slotId))?.mediaId, "first");
    const removed = render(nextRun, { ...graph, nodes: [] });
    assert.equal(removed.outputs.size, 0);
    assert.equal(removed.count, 1);
    assert.equal(render(undefined).outputs.size, 0);
    assert.equal(render(undefined).count, 0);
    harness.unmount();
});

test("workflow adapter reuses visual arrays across viewport rerenders and refreshes when graph changes", () => {
    const harness = hookHarness();
    const counts = { nodes: 0, connections: 0 };
    const interactions = { resetInteractionState() {} };
    const { useWorkflowInteractions: useHook } = sourceModule<{ useWorkflowInteractions: typeof useWorkflowInteractions }>(interactionsURL, {
        react: harness.hooks,
        nanoid: { nanoid: () => "new-id" },
        "@/app/(user)/canvas/hooks/use-canvas-interactions": { useCanvasInteractions: () => interactions },
        "./workflow-graph": workflowGraph,
        "./workflow-canvas-adapter": {
            ...adapter,
            toWorkflowCanvasNodes: (graph: WorkflowGraph) => { counts.nodes++; return adapter.toWorkflowCanvasNodes(graph); },
            toWorkflowCanvasConnections: (graph: WorkflowGraph) => { counts.connections++; return adapter.toWorkflowCanvasConnections(graph); },
        },
    }, { window: new EventTarget() });
    const input = workflowGraph.createWorkflowNode("text_input", { x: 10, y: 20 }, "input");
    const graph: WorkflowGraph = { version: 1, nodes: [input], connections: [] };
    const options: Parameters<typeof useWorkflowInteractions>[0] = { graph, setGraph() {}, viewport: { x: 0, y: 0, k: 1 }, screenToCanvas: (x, y) => ({ x, y }), pause() {}, resume() {}, onWarning() {} };
    const first = harness.render(() => useHook(options));
    const panned = harness.render(() => useHook({ ...options, viewport: { x: 500, y: -100, k: 0.5 }, onWarning() {} }));
    assert.equal(panned.nodes, first.nodes);
    assert.equal(panned.connections, first.connections);
    assert.deepEqual(counts, { nodes: 1, connections: 1 });
    const generation = workflowGraph.createWorkflowNode("image_generation", { x: 600, y: 20 }, "generation");
    const nextGraph = workflowGraph.addWorkflowConnection({ ...graph, nodes: [input, generation] }, { sourceNodeId: input.id, sourceSlotId: "output", targetNodeId: generation.id });
    const changed = harness.render(() => useHook({ ...options, graph: nextGraph }));
    assert.notEqual(changed.nodes, first.nodes);
    assert.notEqual(changed.connections, first.connections);
    assert.deepEqual(changed.nodes, adapter.toWorkflowCanvasNodes(nextGraph));
    assert.deepEqual(changed.connections, adapter.toWorkflowCanvasConnections(nextGraph));
    assert.deepEqual(counts, { nodes: 2, connections: 2 });
    harness.unmount();
    assert.equal(harness.postUnmountUpdates, 0);
});

function previewCallback(graph: WorkflowGraph, detail: { graph: WorkflowGraph; outputs: WorkflowOutputExecution[] } | undefined) {
    const useMemo = (create: () => unknown) => create();
    const indexes = sourceBehavior(editorURL, { graph, useMemo });
    const nodesById = indexes.named("nodesById");
    const inputConnectionsByTarget = indexes.named("inputConnectionsByTarget");
    const resourceId = runState.workflowOutputResourceNodeId("run", "generated", "slot");
    return sourceBehavior(editorURL, {
        graph,
        nodesById,
        inputConnectionsByTarget,
        compatibleOutputs: runState.indexCompatibleWorkflowOutputs(detail, graph),
        currentRun: { data: detail ? { ...detail, run: { id: "run" } } : undefined },
        imageResources: { resources: new Map([[resourceId, { url: "blob:generated", storageKey: "media:generated" }]]), errors: new Map([["image", "loading failed"]]) },
        workflowSourceType: workflowGraph.workflowSourceType,
        workflowOutputKey: runState.workflowOutputKey,
        workflowOutputResourceNodeId: runState.workflowOutputResourceNodeId,
        useCallback: (callback: unknown) => callback,
    }).named("previewInputs") as (targetId: string) => Array<Record<string, unknown>>;
}

test("indexed preview inputs preserve target grouping, stable order, source types and run resource identity", () => {
    const nodes: WorkflowNode[] = [
        { id: "text", type: "text_input", text: "first text", position: { x: 0, y: 0 } },
        { id: "image", type: "image_input", mediaId: "image-media", position: { x: 0, y: 0 } },
        { id: "generated", type: "image_generation", outputs: [{ id: "slot", type: "image" }], position: { x: 0, y: 0 } },
    ];
    const connection = (sourceNodeId: string, targetPortId: string, order: number, sourceSlotId = "output", targetNodeId = "target"): WorkflowConnection => ({ sourceNodeId, sourceSlotId, targetNodeId, targetPortId, order });
    const connections = [connection("image", "image-port", 2), connection("text", "tie-a", 1), connection("generated", "other-port", 0, "slot", "other"), connection("text", "tie-b", 1), connection("missing", "missing", 0), connection("generated", "invalid-slot", 0, "missing"), connection("generated", "generated-port", 3, "slot")];
    const graph: WorkflowGraph = { version: 1, nodes, connections };
    const output: WorkflowOutputExecution = { runId: "run", nodeId: "generated", slotId: "slot", status: "succeeded", attempt: 1, mediaId: "generated-media", updatedAt: "now" };
    const preview = previewCallback(graph, { graph, outputs: [output] });
    assert.deepEqual(preview("target"), [
        { key: "tie-a", sourceNodeId: "text", type: "text", text: "first text" },
        { key: "tie-b", sourceNodeId: "text", type: "text", text: "first text" },
        { key: "image-port", sourceNodeId: "image", type: "image", mediaId: "image-media", imageError: "loading failed" },
        { key: "generated-port", sourceNodeId: runState.workflowOutputResourceNodeId("run", "generated", "slot"), type: "image", mediaId: "generated-media", imageUrl: "blob:generated", imageStorageKey: "media:generated" },
    ]);
    assert.equal(preview("other")[0]!.key, "other-port");
    assert.deepEqual(preview("missing-target"), []);
    assert.deepEqual(connections.map((item) => item.targetPortId), ["image-port", "tie-a", "other-port", "tie-b", "missing", "invalid-slot", "generated-port"]);
    assert.equal(previewCallback(graph, undefined)("target")[3]!.mediaId, undefined);
    const changed: WorkflowGraph = { ...graph, nodes: nodes.map((item) => item.id === "generated" ? { ...item, type: "video_generation", outputs: [{ id: "slot", type: "video" }] } : item) };
    const changedPreview = previewCallback(changed, { graph, outputs: [output] })("target")[3]!;
    assert.equal(changedPreview.type, "video");
    assert.equal(changedPreview.mediaId, undefined);
});

test("preview grouping reads each connection once before serving every target", () => {
    const nodes = Array.from({ length: 100 }, (_, index) => workflowGraph.createWorkflowNode("text_input", { x: 0, y: 0 }, `n-${index}`));
    const entries: WorkflowConnection[] = nodes.flatMap((item) => Array.from({ length: 9 }, (_, index) => ({ sourceNodeId: item.id, sourceSlotId: "output", targetNodeId: `target-${index}`, targetPortId: `${item.id}-${index}`, order: index })));
    let reads = 0;
    const connections = new Proxy(entries, { get(target, property, receiver) { if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) reads++; return Reflect.get(target, property, receiver); } });
    const graph: WorkflowGraph = { version: 1, nodes, connections };
    const preview = previewCallback(graph, undefined);
    for (let index = 0; index < 9; index++) assert.equal(preview(`target-${index}`).length, nodes.length);
    assert.ok(reads <= entries.length * 2, `connection reads: ${reads}`);
});
