import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasInteractionController } from "@/app/(user)/canvas/hooks/use-canvas-interactions";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/app/(user)/canvas/types";
import { canvasFrameRectsOverlap } from "@/lib/canvas-frame";
import { addWorkflowConnection, appendWorkflowOutput, createWorkflowNode, emptyWorkflowGraph } from "./workflow-graph";
import { applyWorkflowVisualConnections, applyWorkflowVisualNodes, copyWorkflowSelection, copyWorkflowFrameSelection, deleteWorkflowVisualSelection, normalizeWorkflowCanvasConnection, parseWorkflowVisualId, pasteWorkflowSelection, toWorkflowCanvasConnections, toWorkflowCanvasNodes, workflowVisualNodeId, workflowVisualOutputId } from "./workflow-canvas-adapter";

function fixture() {
    const input = createWorkflowNode("image_input", { x: 0, y: 0 }, "input:with:colon");
    const generation = createWorkflowNode("image_generation", { x: 500, y: 0 }, "generation");
    const video = createWorkflowNode("video_generation", { x: 1500, y: 0 }, "video");
    return { ...emptyWorkflowGraph(), nodes: [input, generation, video] };
}

test("visual IDs preserve arbitrary graph and output IDs without collisions", () => {
    assert.notEqual(workflowVisualOutputId("a:b", "c"), workflowVisualOutputId("a", "b:c"));
    assert.deepEqual(parseWorkflowVisualId(workflowVisualNodeId('a:["b"]')), { kind: "node", nodeId: 'a:["b"]' });
    assert.equal(parseWorkflowVisualId("invalid"), null);
    assert.equal(parseWorkflowVisualId('["node", 1]'), null);
});

test("visual movement and resizing write only definition positions, preserving port identity", () => {
    const graph = addWorkflowConnection(fixture(), { sourceNodeId: "input:with:colon", sourceSlotId: "output", targetNodeId: "generation" });
    const visuals = toWorkflowCanvasNodes(graph);
    const slotId = graph.nodes[1]!.outputs![0]!.id;
    const updated = applyWorkflowVisualNodes(graph, visuals.map((node) => node.id === workflowVisualOutputId("generation", slotId) ? { ...node, position: { x: 1100, y: 500 }, width: 400 } : node));
    assert.deepEqual(updated.connections, graph.connections);
    assert.deepEqual(updated.nodes[1]!.inputPorts, graph.nodes[1]!.inputPorts);
    assert.equal(updated.nodes[1]!.outputs![0]!.id, slotId);
    assert.equal(updated.nodes[1]!.outputs![0]!.width, 400);
    assert.deepEqual(updated.nodes[1]!.position, graph.nodes[1]!.position);
    assert.equal(applyWorkflowVisualNodes(graph, visuals), graph);
    assert.equal(visuals[1]!.type, CanvasNodeType.Config);
});

test("forward and reverse connection gestures enforce typed ports, limits and cycles without mutating hover graph", () => {
    let graph = fixture();
    const input = workflowVisualNodeId(graph.nodes[0]!.id);
    const target = workflowVisualNodeId("generation");
    const before = JSON.stringify(graph);
    assert.deepEqual(normalizeWorkflowCanvasConnection(graph, target, input, "target"), { fromNodeId: input, toNodeId: target });
    assert.equal(JSON.stringify(graph), before);
    assert.equal(normalizeWorkflowCanvasConnection(graph, input, target, "source", () => { throw new Error("model limit"); }), null);
    assert.equal(normalizeWorkflowCanvasConnection(graph, target, workflowVisualNodeId("video"), "source"), null);
    const sourceSlot = graph.nodes[1]!.outputs![0]!.id;
    graph = addWorkflowConnection(graph, { sourceNodeId: "generation", sourceSlotId: sourceSlot, targetNodeId: "video" });
    const videoOutput = workflowVisualOutputId("video", graph.nodes[2]!.outputs![0]!.id);
    assert.equal(normalizeWorkflowCanvasConnection(graph, videoOutput, target, "source"), null);
    graph = addWorkflowConnection(graph, { sourceNodeId: graph.nodes[0]!.id, sourceSlotId: "output", targetNodeId: "generation" });
    assert.equal(normalizeWorkflowCanvasConnection(graph, input, target, "source"), null);
});

test("visual connections preserve existing port IDs and removing one cleans only its port", () => {
    let graph = addWorkflowConnection(fixture(), { sourceNodeId: "input:with:colon", sourceSlotId: "output", targetNodeId: "generation" });
    const originalPort = graph.connections[0]!.targetPortId;
    const visuals = toWorkflowCanvasConnections(graph);
    graph = applyWorkflowVisualConnections(graph, [...visuals, { id: "new", fromNodeId: workflowVisualOutputId("generation", graph.nodes[1]!.outputs![0]!.id), toNodeId: workflowVisualNodeId("video") }]);
    assert.equal(graph.connections[0]!.targetPortId, originalPort);
    assert.equal(graph.nodes[2]!.inputPorts?.length, 1);
    graph = applyWorkflowVisualConnections(graph, toWorkflowCanvasConnections(graph).filter((connection) => connection.id !== visuals[0]!.id));
    assert.equal(graph.nodes[1]!.inputPorts?.length, 0);
    assert.equal(graph.nodes[2]!.inputPorts?.length, 1);
});

test("copy/paste clones a selected subgraph with new node, slot and port IDs and removes external inputs", () => {
    let graph = fixture();
    graph = addWorkflowConnection(graph, { sourceNodeId: "input:with:colon", sourceSlotId: "output", targetNodeId: "generation" });
    graph = addWorkflowConnection(graph, { sourceNodeId: "generation", sourceSlotId: graph.nodes[1]!.outputs![0]!.id, targetNodeId: "video" });
    const copied = copyWorkflowSelection(graph, new Set([workflowVisualNodeId("generation"), workflowVisualNodeId("video")]));
    let sequence = 0;
    const pasted = pasteWorkflowSelection(graph, copied, { x: 40, y: 50 }, () => `clone-${++sequence}`);
    const generated = pasted.graph.nodes[3]!;
    const video = pasted.graph.nodes[4]!;
    assert.equal(generated.inputPorts?.length, 0);
    assert.equal(video.inputPorts?.length, 1);
    assert.notEqual(generated.outputs![0]!.id, graph.nodes[1]!.outputs![0]!.id);
    assert.notEqual(video.inputPorts![0]!.id, graph.nodes[2]!.inputPorts![0]!.id);
    assert.equal(pasted.graph.connections[2]!.sourceNodeId, generated.id);
    assert.equal(pasted.graph.connections[2]!.sourceSlotId, generated.outputs![0]!.id);
    assert.deepEqual(generated.position, { x: 540, y: 50 });
    assert.equal(pasted.selectedNodeIds.size, 4);
    assert.equal(graph.nodes.length, 3);
});

test("deleting a definition removes its outputs and connections, but protected slot deletion is atomic", () => {
    let graph = appendWorkflowOutput(fixture(), "generation");
    const slotId = graph.nodes[1]!.outputs![1]!.id;
    graph = addWorkflowConnection(graph, { sourceNodeId: "generation", sourceSlotId: slotId, targetNodeId: "video" });
    assert.throws(() => deleteWorkflowVisualSelection(graph, new Set([workflowVisualOutputId("generation", slotId)])), /仍有连线/);
    const next = deleteWorkflowVisualSelection(graph, new Set([workflowVisualNodeId("generation"), workflowVisualOutputId("generation", slotId)]));
    assert.equal(next.nodes.length, 2);
    assert.equal(next.connections.length, 0);
    assert.equal(next.nodes[1]!.inputPorts?.length, 0);
});

test("shared Canvas controller drags workflow output independently and connects by dragging target handle", () => {
    let graph = fixture();
    const nodesRef = { current: toWorkflowCanvasNodes(graph) };
    const connectionsRef = { current: toWorkflowCanvasConnections(graph) };
    const selectedNodeIdsRef = { current: new Set<string>() };
    const update = () => { nodesRef.current = toWorkflowCanvasNodes(graph); connectionsRef.current = toWorkflowCanvasConnections(graph); };
    const setNodes = (next: CanvasNodeData[] | ((previous: CanvasNodeData[]) => CanvasNodeData[])) => { graph = applyWorkflowVisualNodes(graph, typeof next === "function" ? next(nodesRef.current) : next); update(); };
    const setConnections = (next: CanvasConnection[] | ((previous: CanvasConnection[]) => CanvasConnection[])) => { graph = applyWorkflowVisualConnections(graph, typeof next === "function" ? next(connectionsRef.current) : next); update(); };
    const calls: string[] = [];
    let frame: FrameRequestCallback | undefined;
    const controller = createCanvasInteractionController({
        nodesRef, connectionsRef, selectedNodeIdsRef, viewportRef: { current: { x: 0, y: 0, k: 1 } }, setNodes, setConnections,
        setSelectedNodeIds: (next) => { selectedNodeIdsRef.current = typeof next === "function" ? next(selectedNodeIdsRef.current) : next; },
        setSelectedConnectionId: () => {},
        pause: () => calls.push("pause"), resume: () => calls.push("resume"), screenToCanvas: (x, y) => ({ x, y }),
        normalizeConnection: (first, second, _nodes, handle) => normalizeWorkflowCanvasConnection(graph, first, second, handle),
        requestAnimationFrame: (next) => { frame = next; return 1; }, cancelAnimationFrame: () => { frame = undefined; },
    });
    const slotId = graph.nodes[1]!.outputs![0]!.id;
    const outputId = workflowVisualOutputId("generation", slotId);
    controller.handleNodeMouseDown({ clientX: 960, clientY: 10 }, outputId);
    controller.handleGlobalMouseMove({ clientX: 1000, clientY: 40 }); frame?.(0);
    controller.handleGlobalMouseUp({ clientX: 1000, clientY: 40 });
    assert.deepEqual(calls, ["pause", "resume"]);
    assert.deepEqual(graph.nodes[1]!.position, { x: 500, y: 0 });
    assert.deepEqual(graph.nodes[1]!.outputs![0]!.position, { x: 996, y: 40 });
    controller.handleConnectStart({ clientX: 500, clientY: 100 }, workflowVisualNodeId("generation"), "target");
    controller.handleGlobalMouseMove({ clientX: 50, clientY: 50 });
    controller.handleGlobalMouseUp({ clientX: 50, clientY: 50 });
    assert.equal(graph.connections.length, 1);
    assert.equal(graph.connections[0]!.sourceNodeId, "input:with:colon");
    assert.equal(graph.nodes[1]!.inputPorts?.length, 1);
    controller.dispose();
});


test("copying output slots does not silently expand selection to generation owners", () => {
    const graph = fixture();
    const owner = graph.nodes[1]!;
    const slotId = owner.outputs![0]!.id;
    assert.equal(copyWorkflowSelection(graph, new Set([workflowVisualOutputId(owner.id, slotId)])).nodes.length, 0);
    const copied = copyWorkflowSelection(graph, new Set([workflowVisualNodeId(owner.id), workflowVisualOutputId(owner.id, slotId)]));
    assert.equal(copied.nodes.length, 1);
    assert.deepEqual(copied.nodes[0]!.outputs, owner.outputs);
    const mixed = copyWorkflowSelection(graph, new Set([workflowVisualNodeId(graph.nodes[0]!.id), workflowVisualOutputId(owner.id, slotId)]));
    assert.equal(mixed.nodes.length, 1);
    assert.equal(mixed.nodes[0]!.id, graph.nodes[0]!.id);
});

test("copying a Frame includes its members but excludes external references and remaps every identity", () => {
    let graph = addWorkflowConnection(fixture(), { sourceNodeId: "input:with:colon", sourceSlotId: "output", targetNodeId: "generation" });
    graph = addWorkflowConnection(graph, { sourceNodeId: "generation", sourceSlotId: graph.nodes[1]!.outputs![0]!.id, targetNodeId: "video" });
    const frame = { id: "frame-a", name: "分支 A", position: { x: 440, y: -60 }, width: 1800, height: 500, nodeIds: ["generation", "video"] };
    const framed = { ...graph, frames: [frame] };
    const copied = copyWorkflowFrameSelection(framed, frame.id);
    assert.equal(copied.frames?.length, 1);
    assert.equal(copied.nodes.length, 2);
    assert.equal(copied.connections.length, 1);
    assert.equal(copied.nodes[0]!.inputPorts?.length, 0);
    let sequence = 0;
    const pasted = pasteWorkflowSelection(framed, copied, { x: 48, y: 48 }, () => `copy-${++sequence}`);
    const result = pasted.graph.frames![1]!;
    assert.notEqual(result.id, frame.id);
    assert.equal(result.name, frame.name);
    assert.equal(canvasFrameRectsOverlap(frame, result), false);
    assert.deepEqual(result.nodeIds, pasted.graph.nodes.slice(3).map((node) => node.id));
    assert.equal(pasted.selectedFrameId, result.id);
    assert.equal(pasted.selectedNodeIds.size, 0);
    assert.deepEqual(framed.frames, [frame]);
    const ordinary = copyWorkflowSelection(framed, new Set([workflowVisualNodeId("generation")]));
    assert.equal(ordinary.frames, undefined);
});

test("deleting a member removes membership without deleting its Frame", () => {
    const base = fixture();
    const graph = { ...base, frames: [{ id: "frame-a", name: "A", position: { x: 0, y: 0 }, width: 2000, height: 600, nodeIds: ["generation", "video"] }] };
    const next = deleteWorkflowVisualSelection(graph, new Set([workflowVisualNodeId("generation")]));
    assert.deepEqual(next.frames?.[0]?.nodeIds, ["video"]);
    assert.equal(next.frames?.[0]?.id, "frame-a");
    assert.deepEqual(graph.frames[0]!.nodeIds, ["generation", "video"]);
});


test("Frame paste rejects capacity before mutating nodes or allocating identities", () => {
    const graph = { ...fixture(), frames: Array.from({ length: 1000 }, (_, index) => ({ id: `frame-${index}`, name: "Frame", position: { x: 0, y: 0 }, width: 480, height: 320, nodeIds: [] })) };
    const copied = copyWorkflowFrameSelection(graph, "frame-0");
    const before = structuredClone(graph);
    assert.throws(() => pasteWorkflowSelection(graph, copied, undefined, () => { throw new Error("should not allocate"); }), /1000/);
    assert.deepEqual(graph, before);
});
