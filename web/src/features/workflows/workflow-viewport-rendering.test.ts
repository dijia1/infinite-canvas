import assert from "node:assert/strict";
import test from "node:test";

import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/app/(user)/canvas/types";
import { workflowVisualNodeId, workflowVisualOutputId } from "./workflow-canvas-adapter";
import { buildWorkflowPathData, selectWorkflowViewportScene, workflowConnectionPathCache, workflowOutputLinks, workflowOutputPathCache, workflowSelectedImageResourceIds, workflowVisualRenderDetail } from "./workflow-viewport-rendering";
import { workflowOutputKey, workflowOutputResourceNodeId } from "./workflow-run-state";
import type { WorkflowGraph, WorkflowOutputExecution } from "./types";

function visual(id: string, x: number, y = 100): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: "", position: { x, y }, width: 120, height: 120 };
}

const viewport = { x: 0, y: 0, k: 1 };
const viewportSize = { width: 800, height: 600 };

test("selects only visible workflow objects and their fully visible connections", () => {
    const insideA = visual("inside-a", 100);
    const insideB = visual("inside-b", 400);
    const outside = visual("outside", 2000);
    const connections: CanvasConnection[] = [
        { id: "visible", fromNodeId: insideA.id, toNodeId: insideB.id },
        { id: "hidden", fromNodeId: insideB.id, toNodeId: outside.id },
    ];
    const outputLinks = [
        { id: "visible-output", fromNodeId: insideA.id, toNodeId: insideB.id },
        { id: "hidden-output", fromNodeId: insideB.id, toNodeId: outside.id },
    ];

    const scene = selectWorkflowViewportScene({
        nodes: [insideA, insideB, outside],
        connections,
        outputLinks,
        viewport,
        viewportSize,
        retainedNodeIds: new Set(),
        interactiveConnectionIds: new Set(),
    });

    assert.deepEqual([...scene.visibleNodeIds], [insideA.id, insideB.id]);
    assert.deepEqual(scene.visibleConnections.map((connection) => connection.id), ["visible"]);
    assert.deepEqual(scene.visibleOutputLinks.map((connection) => connection.id), ["visible-output"]);
    assert.equal(scene.nodeById.get(outside.id), outside);
});

test("retains selected offscreen objects without treating their normal edges as visible", () => {
    const inside = visual("inside", 100);
    const outside = visual("outside", 2000);
    const connection = { id: "edge", fromNodeId: inside.id, toNodeId: outside.id };

    const scene = selectWorkflowViewportScene({
        nodes: [inside, outside],
        connections: [connection],
        outputLinks: [],
        viewport,
        viewportSize,
        retainedNodeIds: new Set([outside.id]),
        interactiveConnectionIds: new Set(),
    });

    assert.equal(scene.visibleNodeIds.has(outside.id), true);
    assert.deepEqual(scene.visibleConnections, [connection]);
});

test("keeps an interactive curve crossing the viewport even when its endpoints are culled", () => {
    const left = visual("left", -1000);
    const right = visual("right", 1500);
    const connection = { id: "selected-edge", fromNodeId: left.id, toNodeId: right.id };

    const scene = selectWorkflowViewportScene({
        nodes: [left, right],
        connections: [connection],
        outputLinks: [],
        viewport,
        viewportSize,
        retainedNodeIds: new Set(),
        interactiveConnectionIds: new Set([connection.id]),
    });

    assert.deepEqual(scene.visibleConnections, [connection]);
});

test("an unmeasured viewport renders retained objects only", () => {
    const inside = visual("inside", 0, 0);
    const retained = visual("retained", 2000);
    const scene = selectWorkflowViewportScene({
        nodes: [inside, retained],
        connections: [{ id: "edge", fromNodeId: inside.id, toNodeId: retained.id }],
        outputLinks: [],
        viewport,
        viewportSize: { width: 0, height: 0 },
        retainedNodeIds: new Set([retained.id]),
        interactiveConnectionIds: new Set(),
    });

    assert.deepEqual([...scene.visibleNodeIds], [retained.id]);
    assert.deepEqual(scene.visibleConnections, []);
});

test("builds collision-safe output links for arbitrary workflow identifiers", () => {
    const graph: WorkflowGraph = {
        version: 1,
        connections: [],
        nodes: [{
            id: "generation:one",
            type: "image_generation",
            position: { x: 10, y: 20 },
            outputs: [{ id: "slot:[one]", type: "image", position: { x: 500, y: 20 } }],
        }],
    };

    const links = workflowOutputLinks(graph);
    assert.deepEqual(links, [{
        id: `workflow-output:${workflowVisualOutputId("generation:one", "slot:[one]")}`,
        fromNodeId: workflowVisualNodeId("generation:one"),
        toNodeId: workflowVisualOutputId("generation:one", "slot:[one]"),
    }]);
});

test("maps selected image inputs and generated outputs to original-resource pins", () => {
    const graph: WorkflowGraph = {
        version: 1,
        connections: [],
        nodes: [
            { id: "input", type: "image_input", mediaId: "input-media", position: { x: 0, y: 0 } },
            { id: "video", type: "video_input", mediaId: "video-media", position: { x: 0, y: 0 } },
            { id: "generation", type: "image_generation", position: { x: 0, y: 0 }, outputs: [
                { id: "image-slot", type: "image" },
                { id: "video-slot", type: "video" },
            ] },
        ],
    };
    const imageOutput: WorkflowOutputExecution = { runId: "run", nodeId: "generation", slotId: "image-slot", status: "succeeded", attempt: 1, mediaId: "result", updatedAt: "now" };
    const outputs = new Map([[workflowOutputKey("generation", "image-slot"), imageOutput]]);

    const pinned = workflowSelectedImageResourceIds(graph, new Set([
        workflowVisualNodeId("input"),
        workflowVisualNodeId("video"),
        workflowVisualOutputId("generation", "image-slot"),
        workflowVisualOutputId("generation", "video-slot"),
    ]), outputs);

    assert.deepEqual([...pinned], ["input", workflowOutputResourceNodeId("run", "generation", "image-slot")]);
});

test("caches business and output curves from a single visual-node index", () => {
    const source = { ...visual("source", 10), width: 100, height: 80 };
    const target = { ...visual("target", 300, 200), width: 120, height: 100 };
    const connection = { id: "business", fromNodeId: source.id, toNodeId: target.id };
    const outputLink = { id: "output", fromNodeId: source.id, toNodeId: target.id };
    const nodeById = new Map([[source.id, source], [target.id, target]]);

    assert.equal(workflowConnectionPathCache([connection], nodeById).get(connection.id), "M 110 140 C 205 140, 205 250, 300 250");
    assert.equal(workflowOutputPathCache([outputLink], nodeById).get(outputLink.id), "M 110 140 C 158 140, 252 250, 300 250");
});

test("combines cached overview paths while excluding interactive edges", () => {
    const links = [
        { id: "normal", fromNodeId: "a", toNodeId: "b" },
        { id: "interactive", fromNodeId: "b", toNodeId: "c" },
        { id: "missing", fromNodeId: "c", toNodeId: "d" },
    ];
    const paths = new Map([["normal", "M normal"], ["interactive", "M interactive"]]);

    assert.equal(buildWorkflowPathData(links, paths, new Set(["interactive"])), "M normal");
});

test("keeps active workflow objects fully interactive in overview mode", () => {
    assert.equal(workflowVisualRenderDetail("overview", "selected", new Set(["selected"])), "full");
    assert.equal(workflowVisualRenderDetail("overview", "idle", new Set(["selected"])), "overview");
    assert.equal(workflowVisualRenderDetail("full", "idle", new Set()), "full");
});
