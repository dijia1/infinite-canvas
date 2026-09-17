import assert from "node:assert/strict";
import test from "node:test";

import { sourceBehavior } from "@/test-utils/source-behavior";
import { hookHarness, sourceModule } from "../../test-utils/source-component";
import * as adapter from "./workflow-canvas-adapter";
import * as workflowFrames from "./workflow-frames";
import * as workflowGraph from "./workflow-graph";
import * as runState from "./workflow-run-state";
import type { useWorkflowInteractions } from "./use-workflow-interactions";
import type { WorkflowConnection, WorkflowGraph, WorkflowNode, WorkflowOutputExecution, WorkflowRunDetail } from "./types";

const editorURL = new URL("./workflow-editor.tsx", import.meta.url);
const interactionsURL = new URL("./use-workflow-interactions.ts", import.meta.url);

function runDetail(node: WorkflowNode, runId: string, status: WorkflowOutputExecution["status"] = "succeeded"): WorkflowRunDetail {
    const graph: WorkflowGraph = { version: 1, nodes: [node], connections: [] };
    const slotId = node.outputs![0]!.id;
    return {
        run: { id: runId, requestId: `${runId}-request`, workflowId: "workflow", revision: 1, title: "Workflow", scopeType: "frame", frameId: `frame-${node.id}`, frameName: node.id, status: status === "succeeded" ? "completed" : "running", stopRequested: false, createdAt: "now", updatedAt: "now" },
        graph,
        steps: [],
        attempts: [],
        outputs: [{ runId, nodeId: node.id, slotId, status, attempt: status === "succeeded" ? 1 : 2, ...(status === "succeeded" ? { mediaId: `media-${runId}` } : {}), updatedAt: "now" }],
    };
}

test("editor indexes simultaneous Frame outputs by node while downloads stay selected-run scoped", () => {
    const harness = hookHarness();
    const nodeA = workflowGraph.createWorkflowNode("image_generation", { x: 0, y: 0 }, "a");
    const nodeB = workflowGraph.createWorkflowNode("image_generation", { x: 500, y: 0 }, "b");
    const graph: WorkflowGraph = { version: 1, nodes: [nodeA, nodeB], connections: [] };
    const detailA = runDetail(nodeA, "run-a");
    const detailB = runDetail(nodeB, "run-b");
    const cached = new Map([["run-a", detailA], ["run-b", detailB]]);
    const both = runState.indexWorkflowRunDetailsByNode(cached, { a: "run-a", b: "run-b" }, graph);
    const render = (detailByNode: ReadonlyMap<string, WorkflowRunDetail>, selectedDetail: WorkflowRunDetail | undefined, currentGraph = graph) => harness.render(() => {
        const production = sourceBehavior(editorURL, { useMemo: harness.hooks.useMemo, currentRun: { data: selectedDetail }, runs: { detailByNode }, graph: currentGraph, indexWorkflowRunOutputsByNode: runState.indexWorkflowRunOutputsByNode, workflowDownloadImageCount: runState.workflowDownloadImageCount });
        return { outputs: production.named("compatibleOutputs") as Map<string, WorkflowOutputExecution>, count: production.named("downloadImageCount") as number };
    });
    const initial = render(both, detailA);
    assert.equal(render(both, detailA).outputs, initial.outputs);
    assert.equal(initial.count, 1);
    assert.equal(initial.outputs.get(runState.workflowOutputKey("a", nodeA.outputs![0]!.id))?.runId, "run-a");
    assert.equal(initial.outputs.get(runState.workflowOutputKey("b", nodeB.outputs![0]!.id))?.runId, "run-b");

    const retryB = runDetail(nodeB, "run-b", "running");
    const retry = render(new Map([["a", detailA], ["b", retryB]]), retryB);
    assert.equal(retry.outputs.get(runState.workflowOutputKey("b", nodeB.outputs![0]!.id))?.attempt, 2);
    assert.equal(retry.count, 0);

    assert.equal(cached.get("run-b")?.outputs[0]?.mediaId, "media-run-b");
    const exactSources = runState.indexWorkflowRunDetailsByNode(cached, { a: "run-a", b: "run-b-new" }, graph);
    const newerDetailMissing = render(exactSources, undefined);
    assert.equal(newerDetailMissing.outputs.has(runState.workflowOutputKey("b", nodeB.outputs![0]!.id)), false);
    assert.equal(newerDetailMissing.outputs.get(runState.workflowOutputKey("a", nodeA.outputs![0]!.id))?.runId, "run-a");

    const removed = render(both, detailA, { ...graph, nodes: [] });
    assert.equal(removed.outputs.size, 0, "editable graph compatibility still gates display");
    assert.equal(removed.count, 1);
    assert.equal(render(new Map(), undefined).outputs.size, 0);
    assert.equal(render(new Map(), undefined).count, 0);
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
        "./workflow-frames": workflowFrames,
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

test("workflow member drag expands its Frame before pointer release and never shrinks it during the gesture", () => {
    const harness = hookHarness();
    let sharedOptions: Record<string, any> | undefined;
    let currentGraph: WorkflowGraph = {
        version: 1,
        frames: [{ id: "frame", name: "Frame", position: { x: 0, y: 0 }, width: 600, height: 400, nodeIds: ["image"] }],
        nodes: [{ id: "image", type: "image_input", position: { x: 100, y: 100 }, width: 200, height: 100 }],
        connections: [],
    };
    const { useWorkflowInteractions: useHook } = sourceModule<{ useWorkflowInteractions: typeof useWorkflowInteractions }>(interactionsURL, {
        react: harness.hooks,
        nanoid: { nanoid: () => "new-id" },
        "@/app/(user)/canvas/hooks/use-canvas-interactions": { useCanvasInteractions: (options: Record<string, any>) => {
            sharedOptions = options;
            return { resetInteractionState() {} };
        } },
        "./workflow-graph": workflowGraph,
        "./workflow-canvas-adapter": adapter,
        "./workflow-frames": workflowFrames,
    }, { window: new EventTarget() });
    const setGraph = (update: WorkflowGraph | ((current: WorkflowGraph) => WorkflowGraph)) => {
        currentGraph = typeof update === "function" ? update(currentGraph) : update;
    };
    harness.render(() => useHook({ graph: currentGraph, setGraph, viewport: { x: 0, y: 0, k: 1 }, screenToCanvas: (x, y) => ({ x, y }), pause() {}, resume() {}, onWarning() {} }));
    const visualId = adapter.workflowVisualNodeId("image");
    const initialPositions = new Map([[visualId, { x: 100, y: 100 }]]);
    sharedOptions!.onNodeDragStart({ nodeIds: new Set([visualId]), initialPositions, altKey: false });
    sharedOptions!.setNodes(adapter.toWorkflowCanvasNodes(currentGraph).map((node) => node.id === visualId ? { ...node, position: { x: 700, y: 100 } } : node));
    assert.equal(currentGraph.frames![0]!.width, 924, "Frame expands while the pointer is still down");

    sharedOptions!.setNodes(adapter.toWorkflowCanvasNodes(currentGraph).map((node) => node.id === visualId ? { ...node, position: { x: 150, y: 100 } } : node));
    assert.equal(currentGraph.frames![0]!.width, 924, "live expansion is monotonic");
    sharedOptions!.onNodeDragEnd({ nodeIds: new Set([visualId]), initialPositions, altKey: false, cancelled: true });
    assert.equal(currentGraph.frames![0]!.width, 600, "cancelling restores the pre-drag Frame geometry");
    assert.deepEqual(currentGraph.nodes[0]!.position, { x: 100, y: 100 });
    harness.unmount();
});

test("Option drag prepares a generated media result as its complete logical visual group", () => {
    const harness = hookHarness();
    let dragged: { nodeId: string; selected: string[] } | undefined;
    const generation = workflowGraph.createWorkflowNode("video_generation", { x: 100, y: 100 }, "generation");
    generation.outputs = [
        { id: "image-result", type: "image", position: { x: 500, y: 100 } },
        { id: "video-result", type: "video", position: { x: 500, y: 400 } },
    ];
    const graph: WorkflowGraph = {
        version: 1,
        frames: [{ id: "frame", name: "Frame", position: { x: 0, y: 0 }, width: 900, height: 800, nodeIds: [generation.id] }],
        nodes: [generation],
        connections: [],
    };
    const { useWorkflowInteractions: useHook } = sourceModule<{ useWorkflowInteractions: typeof useWorkflowInteractions }>(interactionsURL, {
        react: harness.hooks,
        nanoid: { nanoid: () => "new-id" },
        "@/app/(user)/canvas/hooks/use-canvas-interactions": { useCanvasInteractions: (options: Record<string, any>) => ({
            resetInteractionState() {},
            handleNodeMouseDown(_event: unknown, nodeId: string) {
                dragged = { nodeId, selected: [...options.selectedNodeIdsRef.current] };
            },
        }) },
        "./workflow-graph": workflowGraph,
        "./workflow-canvas-adapter": adapter,
        "./workflow-frames": workflowFrames,
    }, { window: new EventTarget() });
    const result = harness.render(() => useHook({ graph, setGraph() {}, viewport: { x: 0, y: 0, k: 1 }, screenToCanvas: (x, y) => ({ x, y }), pause() {}, resume() {}, onWarning() {} }));
    const resultId = adapter.workflowVisualOutputId(generation.id, "video-result");
    (result as any).handleNodeMouseDown({ altKey: true }, resultId);

    assert.deepEqual(dragged, {
        nodeId: resultId,
        selected: [
            adapter.workflowVisualNodeId(generation.id),
            adapter.workflowVisualOutputId(generation.id, "image-result"),
            resultId,
        ],
    });
    harness.unmount();
});

test("editor keeps loaded selected detail visible when another runtime query fails", () => {
    const selectedDetail = runDetail(workflowGraph.createWorkflowNode("image_generation", { x: 0, y: 0 }, "selected"), "selected-run");
    const currentRun = sourceBehavior(editorURL, {
        runs: { selectedDetail, selectedError: undefined, error: new Error("unrelated detail failed"), refresh() {} },
    }).named("currentRun") as { data?: WorkflowRunDetail; isError: boolean; error?: unknown };

    assert.equal(currentRun.data, selectedDetail);
    assert.equal(currentRun.isError, false);
    assert.equal(currentRun.error, undefined);
});

test("no-Frame editor uses the whole-workflow latest run as its stable status and download identity", () => {
    const latest = runDetail(workflowGraph.createWorkflowNode("image_generation", { x: 0, y: 0 }, "latest"), "latest-run").run;
    const unframedRun = sourceBehavior(editorURL, {
        graph: { version: 1, nodes: [], connections: [] },
        scopeStates: new Map([[JSON.stringify(["workflow"]), { scope: { type: "workflow" }, latestRun: latest }]]),
        workflowRunScopeKey: () => JSON.stringify(["workflow"]),
    }).named("unframedRun");

    assert.equal(unframedRun, latest);
});

function previewCallback(graph: WorkflowGraph, detailByNode: ReadonlyMap<string, WorkflowRunDetail>) {
    const useMemo = (create: () => unknown) => create();
    const runs = { detailByNode };
    const indexes = sourceBehavior(editorURL, { graph, runs, useMemo });
    const nodesById = indexes.named("nodesById");
    const inputConnectionsByTarget = indexes.named("inputConnectionsByTarget");
    const compatibleOutputs = new Map<string, WorkflowOutputExecution>();
    for (const [nodeId, detail] of detailByNode) {
        for (const [key, output] of runState.indexCompatibleWorkflowOutputs(detail, graph)) if (output.nodeId === nodeId) compatibleOutputs.set(key, output);
    }
    const resources = new Map(
        [...compatibleOutputs.values()]
            .filter((output) => output.mediaId)
            .map((output) => [runState.workflowOutputResourceNodeId(output.runId, output.nodeId, output.slotId), { url: `blob:${output.runId}`, storageKey: `media:${output.runId}` }]),
    );
    return sourceBehavior(editorURL, {
        graph,
        runs,
        nodesById,
        inputConnectionsByTarget,
        compatibleOutputs,
        imageResources: { resources, errors: new Map([["image", "loading failed"]]) },
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
        { id: "generated-a", type: "image_generation", outputs: [{ id: "slot-a", type: "image" }], position: { x: 0, y: 0 } },
        { id: "generated-b", type: "image_generation", outputs: [{ id: "slot-b", type: "image" }], position: { x: 0, y: 0 } },
    ];
    const connection = (sourceNodeId: string, targetPortId: string, order: number, sourceSlotId = "output", targetNodeId = "target"): WorkflowConnection => ({ sourceNodeId, sourceSlotId, targetNodeId, targetPortId, order });
    const connections = [connection("image", "image-port", 2), connection("text", "tie-a", 1), connection("generated-a", "other-port", 0, "slot-a", "other"), connection("text", "tie-b", 1), connection("missing", "missing", 0), connection("generated-a", "invalid-slot", 0, "missing"), connection("generated-a", "generated-a-port", 3, "slot-a"), connection("generated-b", "generated-b-port", 4, "slot-b")];
    const graph: WorkflowGraph = { version: 1, nodes, connections };
    const detailA = runDetail(nodes[2]!, "run-a");
    const detailB = runDetail(nodes[3]!, "run-b");
    const preview = previewCallback(graph, new Map([["generated-a", detailA], ["generated-b", detailB]]));
    assert.deepEqual(preview("target"), [
        { key: "tie-a", sourceNodeId: "text", type: "text", text: "first text" },
        { key: "tie-b", sourceNodeId: "text", type: "text", text: "first text" },
        { key: "image-port", sourceNodeId: "image", type: "image", mediaId: "image-media", imageError: "loading failed" },
        { key: "generated-a-port", sourceNodeId: runState.workflowOutputResourceNodeId("run-a", "generated-a", "slot-a"), type: "image", mediaId: "media-run-a", imageUrl: "blob:run-a", imageStorageKey: "media:run-a" },
        { key: "generated-b-port", sourceNodeId: runState.workflowOutputResourceNodeId("run-b", "generated-b", "slot-b"), type: "image", mediaId: "media-run-b", imageUrl: "blob:run-b", imageStorageKey: "media:run-b" },
    ]);
    assert.equal(preview("other")[0]!.key, "other-port");
    assert.deepEqual(preview("missing-target"), []);
    assert.deepEqual(connections.map((item) => item.targetPortId), ["image-port", "tie-a", "other-port", "tie-b", "missing", "invalid-slot", "generated-a-port", "generated-b-port"]);
    assert.equal(previewCallback(graph, new Map())("target")[3]!.mediaId, undefined);
    const changed: WorkflowGraph = { ...graph, nodes: nodes.map((item) => item.id === "generated-a" ? { ...item, type: "video_generation", outputs: [{ id: "slot-a", type: "video" }] } : item) };
    const changedPreview = previewCallback(changed, new Map([["generated-a", detailA]]))("target")[3]!;
    assert.equal(changedPreview.type, "video");
    assert.equal(changedPreview.mediaId, undefined);
});

test("opened previews keep exact generated output details relevant while their cards are offscreen", () => {
    const source = workflowGraph.createWorkflowNode("image_generation", { x: 2_000, y: 2_000 }, "generated-source");
    const media = workflowGraph.createWorkflowNode("video_generation", { x: 3_000, y: 3_000 }, "generated-media");
    const target = workflowGraph.createWorkflowNode("image_generation", { x: 0, y: 0 }, "target");
    const graph = workflowGraph.addWorkflowConnection(
        { version: 1, nodes: [source, media, target], connections: [] },
        { sourceNodeId: source.id, sourceSlotId: source.outputs![0]!.id, targetNodeId: target.id },
    );
    const visibleRunNodeIds = sourceBehavior(editorURL, {
        graph,
        imageMenu: null,
        previewNodeId: target.id,
        mediaPreview: { node: media, slot: media.outputs![0] },
        viewport: { x: 0, y: 0, k: 1 },
        viewportSize: { width: 800, height: 600 },
        CanvasNodeType: { Image: "image" },
        isCanvasNodeNearViewport: () => false,
        useMemo: (create: () => unknown) => create(),
    }).named("visibleRunNodeIds") as Set<string>;

    assert.deepEqual([...visibleRunNodeIds].sort(), [media.id, source.id].sort());
});

test("preview grouping reads each connection once before serving every target", () => {
    const nodes = Array.from({ length: 100 }, (_, index) => workflowGraph.createWorkflowNode("text_input", { x: 0, y: 0 }, `n-${index}`));
    const entries: WorkflowConnection[] = nodes.flatMap((item) => Array.from({ length: 9 }, (_, index) => ({ sourceNodeId: item.id, sourceSlotId: "output", targetNodeId: `target-${index}`, targetPortId: `${item.id}-${index}`, order: index })));
    let reads = 0;
    const connections = new Proxy(entries, { get(target, property, receiver) { if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) reads++; return Reflect.get(target, property, receiver); } });
    const graph: WorkflowGraph = { version: 1, nodes, connections };
    const preview = previewCallback(graph, new Map());
    for (let index = 0; index < 9; index++) assert.equal(preview(`target-${index}`).length, nodes.length);
    assert.ok(reads <= entries.length * 2, `connection reads: ${reads}`);
});


test("image context selection requests offscreen output details but not every generation node", () => {
    const node = workflowGraph.createWorkflowNode("image_generation", { x: 9000, y: 9000 }, "selected");
    const graph = { version: 1, nodes: [node, workflowGraph.createWorkflowNode("image_generation", { x: 9900, y: 9900 }, "other")], connections: [] };
    const ids = sourceBehavior(editorURL, {
        graph, imageMenu: { selectedIds: new Set([adapter.workflowVisualOutputId(node.id, node.outputs![0]!.id), adapter.workflowVisualNodeId("other")]) },
        parseWorkflowVisualId: adapter.parseWorkflowVisualId,
        previewNodeId: undefined, mediaPreview: undefined,
        viewport: { x: 0, y: 0, k: 1 }, viewportSize: { width: 800, height: 600 },
        CanvasNodeType: { Image: "image" }, isCanvasNodeNearViewport: () => false, useMemo: (create: () => unknown) => create(),
    }).named("visibleRunNodeIds") as Set<string>;
    assert.deepEqual([...ids], ["selected"]);
});
