import assert from "node:assert/strict";
import test from "node:test";

import type { CanvasFrameData } from "@/lib/canvas-frame";
import { autoAssignWorkflowFrameMembers, constrainWorkflowMemberMove, createWorkflowFrame, deleteWorkflowFrame, detachWorkflowFrameMembersInPlace, expandWorkflowFrames, moveWorkflowFrame, resizeWorkflowFrame, resizeWorkflowFrameFromHandle, restoreWorkflowFrameMembersInsideOriginalFrames, workflowFrameOptionDragVisualIds } from "./workflow-frames";
import type { WorkflowGraph } from "./types";
import { workflowVisualNodeId, workflowVisualOutputId } from "./workflow-canvas-adapter";

type FrameGraph = WorkflowGraph & { frames?: CanvasFrameData[] };

function fixture(): FrameGraph {
    return {
        version: 1,
        frames: [
            { id: "frame-a", name: "A", position: { x: 0, y: 0 }, width: 1000, height: 600, nodeIds: ["generation"] },
            { id: "frame-b", name: "B", position: { x: 1400, y: 0 }, width: 600, height: 400, nodeIds: [] },
        ],
        nodes: [
            {
                id: "generation",
                type: "image_generation",
                position: { x: 50, y: 50 },
                width: 360,
                height: 260,
                outputs: [
                    { id: "out-1", type: "image", position: { x: 500, y: 50 }, width: 340, height: 240 },
                    { id: "out-2", type: "image", position: { x: 500, y: 330 }, width: 340, height: 240 },
                ],
            },
            { id: "external-input", type: "text_input", position: { x: -200, y: 50 }, width: 340, height: 240, text: "参考" },
        ],
        connections: [],
    };
}

test("moving a frame moves each member configuration and every output once", () => {
    const graph = fixture();
    const before = structuredClone(graph);
    const moved = moveWorkflowFrame(graph, "frame-a", { x: 100, y: 50 });

    assert.deepEqual(graph, before);
    assert.deepEqual(moved.frames?.[0]?.position, { x: 100, y: 50 });
    assert.deepEqual(moved.nodes[0]?.position, { x: 150, y: 100 });
    assert.deepEqual(
        moved.nodes[0]?.outputs?.map((slot) => slot.position),
        [
            { x: 600, y: 100 },
            { x: 600, y: 380 },
        ],
    );
    assert.deepEqual(moved.nodes[1]?.position, { x: -200, y: 50 });
    assert.equal(moveWorkflowFrame(moved, "frame-a", { x: 0, y: 0 }), moved);
});

test("create, resize, and delete frame helpers keep graph updates bounded and immutable", () => {
    const base = { ...fixture(), frames: undefined };
    const created = createWorkflowFrame(base, { id: "new", name: "New", position: { x: 10, y: 20 } }, new Set([workflowVisualNodeId("generation")]));
    assert.deepEqual(created.frames?.[0], { id: "new", name: "New", position: { x: 26, y: -18 }, width: 838, height: 612, nodeIds: ["generation"] });
    const resized = resizeWorkflowFrame(created, "new", { position: { x: 624, y: 434 }, width: 240, height: 160 });
    assert.deepEqual(resized.frames?.[0], created.frames?.[0]);
    const deleted = deleteWorkflowFrame(resized, "new");
    assert.deepEqual(deleted.frames, []);
    assert.deepEqual(deleted.nodes, base.nodes);
    assert.equal(deleteWorkflowFrame(deleted, "missing"), deleted);
});

test("handle resize uses gesture-start geometry with latest member bounds and Frame metadata", () => {
    const graph = fixture();
    const startFrame = graph.frames![0]!;
    const latest: FrameGraph = {
        ...graph,
        frames: graph.frames!.map((item) => (item.id === startFrame.id ? { ...item, name: "Renamed asynchronously", position: { x: -50, y: -20 }, width: 1100, height: 700 } : item)),
        nodes: graph.nodes.map((node) => (node.id === "generation" ? { ...node, position: { x: 300, y: 50 }, height: 300 } : node)),
    };

    const resized = resizeWorkflowFrameFromHandle(latest, startFrame.id, startFrame, "left", { x: 800, y: 999 });

    assert.deepEqual(resized.frames?.[0], { ...latest.frames?.[0], position: { x: 276, y: -20 }, width: 774, height: 700 });
    assert.equal(resized.nodes, latest.nodes);
    assert.equal(resized.frames?.[1], latest.frames?.[1]);
});

test("handle resize preserves an opposite edge expanded by a late output result", () => {
    const startFrame: CanvasFrameData = { id: "frame", name: "Before", position: { x: 0, y: 0 }, width: 600, height: 400, nodeIds: ["generation"] };
    const latest: FrameGraph = {
        version: 1,
        frames: [{ ...startFrame, name: "After", width: 724 }],
        nodes: [
            {
                id: "generation",
                type: "image_generation",
                position: { x: 100, y: 100 },
                width: 200,
                height: 100,
                outputs: [{ id: "result", type: "image", position: { x: 500, y: 100 }, width: 200, height: 100 }],
            },
        ],
        connections: [],
    };

    const resized = resizeWorkflowFrameFromHandle(latest, startFrame.id, startFrame, "left", { x: 50, y: 0 });

    assert.deepEqual(resized.frames?.[0], { ...latest.frames?.[0], position: { x: 50, y: 0 }, width: 674 });
    assert.equal(resized.nodes, latest.nodes);
});

test("expanding frames after a member moves grows only its owning frame", () => {
    const graph = fixture();
    const movedMember = {
        ...graph,
        nodes: graph.nodes.map((node) => (node.id === "generation" ? { ...node, position: { x: 1100, y: 700 } } : node)),
    };
    const expanded = expandWorkflowFrames(movedMember, new Set([workflowVisualNodeId("generation")]));
    assert.deepEqual(expanded.frames?.[0], { ...graph.frames?.[0], position: { x: 0, y: -18 }, width: 1484, height: 1002 });
    assert.equal(expanded.frames?.[1], graph.frames?.[1]);
    assert.equal(expandWorkflowFrames(expanded, new Set([workflowVisualNodeId("external-input")])), expanded);
});

test("creating a Frame rejects the documented 1000 Frame capacity boundary", () => {
    const graph = {
        ...fixture(),
        frames: Array.from({ length: 1000 }, (_, index) => ({ id: `frame-${index}`, name: `Frame ${index}`, position: { x: 0, y: 0 }, width: 480, height: 320, nodeIds: [] })),
    };
    assert.throws(() => createWorkflowFrame(graph, { id: "overflow", name: "Overflow", position: { x: 0, y: 0 } }), /最多创建 1000 个 Frame/);
});

test("automatic membership uses only a fully contained primary card and expands for its outputs", () => {
    const graph: FrameGraph = {
        ...fixture(),
        nodes: [
            ...fixture().nodes,
            {
                id: "new-generation",
                type: "image_generation",
                position: { x: 1450, y: 80 },
                width: 100,
                height: 100,
                outputs: [{ id: "result", type: "image", position: { x: 2050, y: 80 }, width: 100, height: 100 }],
            },
        ],
    };

    assert.equal(autoAssignWorkflowFrameMembers(graph, new Set([workflowVisualOutputId("new-generation", "result")])), graph);
    const assigned = autoAssignWorkflowFrameMembers(graph, new Set([workflowVisualNodeId("new-generation")]));
    assert.deepEqual(assigned.frames?.map((item) => item.nodeIds), [["generation"], ["new-generation"]]);
    assert.deepEqual(assigned.frames?.[1], { ...graph.frames?.[1], width: 774, nodeIds: ["new-generation"] });
});

test("automatic membership ignores partial containment, existing owners, and ambiguous containing Frames", () => {
    const graph: FrameGraph = {
        version: 1,
        frames: [
            { id: "outer", name: "Outer", position: { x: 0, y: 0 }, width: 600, height: 400, nodeIds: ["owned"] },
            { id: "overlap", name: "Overlap", position: { x: 100, y: 0 }, width: 600, height: 400, nodeIds: [] },
        ],
        nodes: [
            { id: "owned", type: "text_input", position: { x: 200, y: 100 }, width: 100, height: 100, text: "owned" },
            { id: "ambiguous", type: "text_input", position: { x: 200, y: 100 }, width: 100, height: 100, text: "ambiguous" },
            { id: "partial", type: "text_input", position: { x: -1, y: 100 }, width: 100, height: 100, text: "partial" },
        ],
        connections: [],
    };

    const next = autoAssignWorkflowFrameMembers(graph, new Set(graph.nodes.map((node) => workflowVisualNodeId(node.id))));
    assert.equal(next, graph);
});

test("automatic membership evaluates a batch against the pre-assignment Frame geometry", () => {
    const graph: FrameGraph = {
        version: 1,
        frames: [{ id: "frame", name: "Frame", position: { x: 0, y: 0 }, width: 600, height: 400, nodeIds: [] }],
        nodes: [
            {
                id: "inside",
                type: "image_generation",
                position: { x: 100, y: 100 },
                width: 100,
                height: 100,
                outputs: [{ id: "result", type: "image", position: { x: 700, y: 100 }, width: 100, height: 100 }],
            },
            { id: "outside", type: "text_input", position: { x: 700, y: 100 }, width: 100, height: 100, text: "outside" },
        ],
        connections: [],
    };

    const assigned = autoAssignWorkflowFrameMembers(graph, new Set([workflowVisualNodeId("inside"), workflowVisualNodeId("outside")]));
    assert.deepEqual(assigned.frames?.[0]?.nodeIds, ["inside"]);
});

test("Alt detach resolves generated outputs to their logical node and restores only complete groups inside their original Frames", () => {
    const original = fixture();
    const detached = detachWorkflowFrameMembersInPlace(original, new Set([workflowVisualOutputId("generation", "out-1")]));
    assert.deepEqual(detached.frames?.[0]?.nodeIds, []);
    assert.equal(detached.nodes, original.nodes);

    const restored = restoreWorkflowFrameMembersInsideOriginalFrames(detached, new Set([workflowVisualOutputId("generation", "out-1")]), original);
    assert.deepEqual(restored.frames?.[0]?.nodeIds, ["generation"]);

    const partlyOutside = {
        ...detached,
        nodes: detached.nodes.map((node) => (node.id === "generation" ? {
            ...node,
            outputs: node.outputs?.map((slot) => (slot.id === "out-1" ? { ...slot, position: { x: 950, y: 50 } } : slot)),
        } : node)),
    };
    assert.equal(restoreWorkflowFrameMembersInsideOriginalFrames(partlyOutside, new Set([workflowVisualOutputId("generation", "out-1")]), original), partlyOutside);
});

test("Option drag expands media selections to complete logical groups without duplicate visual IDs", () => {
    const graph: FrameGraph = {
        ...fixture(),
        frames: fixture().frames?.map((frame) => frame.id === "frame-a" ? { ...frame, nodeIds: [...frame.nodeIds, "image-input", "video-input"] } : frame),
        nodes: [
            ...fixture().nodes,
            { id: "image-input", type: "image_input", position: { x: 100, y: 700 }, width: 100, height: 100 },
            { id: "video-input", type: "video_input", position: { x: 250, y: 700 }, width: 100, height: 100 },
        ],
    };

    assert.deepEqual(
        [...workflowFrameOptionDragVisualIds(graph, new Set([workflowVisualOutputId("generation", "out-1")]))],
        [workflowVisualNodeId("generation"), workflowVisualOutputId("generation", "out-1"), workflowVisualOutputId("generation", "out-2")],
    );
    assert.deepEqual(
        [...workflowFrameOptionDragVisualIds(graph, new Set([
            workflowVisualNodeId("generation"),
            workflowVisualOutputId("generation", "out-2"),
            workflowVisualNodeId("image-input"),
            workflowVisualNodeId("video-input"),
        ]))],
        [
            workflowVisualNodeId("generation"),
            workflowVisualOutputId("generation", "out-1"),
            workflowVisualOutputId("generation", "out-2"),
            workflowVisualNodeId("image-input"),
            workflowVisualNodeId("video-input"),
        ],
    );
    const detachedInputs = detachWorkflowFrameMembersInPlace(graph, new Set([
        workflowVisualNodeId("image-input"),
        workflowVisualNodeId("video-input"),
    ]));
    assert.deepEqual(detachedInputs.frames?.[0]?.nodeIds, ["generation"]);
});

test("creating a Frame rejects positive overlap and allows boundary contact", () => {
    const graph = fixture();

    assert.throws(() => createWorkflowFrame(graph, { id: "overlap", name: "Overlap", position: { x: 900, y: 100 }, width: 480, height: 320 }), /不能与其他 Frame 重叠/);
    const touching = createWorkflowFrame(graph, { id: "touching", name: "Touching", position: { x: 1000, y: 600 }, width: 400, height: 320 });
    assert.deepEqual(touching.frames?.[2]?.position, { x: 1000, y: 600 });
});

test("moving and resizing Frames stop at the first neighboring Frame boundary", () => {
    const graph = fixture();
    const moved = moveWorkflowFrame(graph, "frame-a", { x: 800, y: 0 });
    assert.deepEqual(moved.frames?.[0]?.position, { x: 400, y: 0 });
    assert.deepEqual(moved.nodes[0]?.position, { x: 450, y: 50 });

    const emptyFrameGraph = { ...graph, frames: graph.frames?.map((frame) => (frame.id === "frame-a" ? { ...frame, nodeIds: [] } : frame)) };
    const resized = resizeWorkflowFrame(emptyFrameGraph, "frame-a", { position: { x: 0, y: 0 }, width: 1800, height: 600 });
    assert.deepEqual(resized.frames?.[0], { ...emptyFrameGraph.frames?.[0], width: 1400 });

    const resizedFromHandle = resizeWorkflowFrameFromHandle(graph, "frame-a", graph.frames![0]!, "right", { x: 800, y: 0 });
    assert.deepEqual(resizedFromHandle.frames?.[0], { ...graph.frames?.[0], width: 1400 });
});

test("member movement is limited so owning Frame expansion reaches contact without overlap", () => {
    const graph = fixture();
    const primaryDelta = constrainWorkflowMemberMove(graph, new Set([workflowVisualNodeId("generation")]), { x: 1000, y: 0 });
    const outputDelta = constrainWorkflowMemberMove(graph, new Set([workflowVisualOutputId("generation", "out-1")]), { x: 1000, y: 0 });

    assert.ok(Math.abs(primaryDelta.x - 966) < 1e-6);
    assert.equal(primaryDelta.y, 0);
    assert.ok(Math.abs(outputDelta.x - 536) < 1e-6);
    assert.equal(outputDelta.y, 0);
});
