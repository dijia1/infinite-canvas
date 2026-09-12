import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowFrameGestureController } from "./use-workflow-frames";
import type { WorkflowGraph } from "./types";

function fixture() {
    let graph: WorkflowGraph = { version: 1, nodes: [{ id: "text", type: "text_input", position: { x: 40, y: 80 }, width: 200, height: 100, text: "before" }], connections: [], frames: [{ id: "a", name: "A", position: { x: 0, y: 0 }, width: 480, height: 320, nodeIds: ["text"] }] };
    let readonly = false;
    let scheduled: FrameRequestCallback | undefined;
    const calls: string[] = [];
    const controller = createWorkflowFrameGestureController({
        updateGraph: (update) => { graph = typeof update === "function" ? update(graph) : update; },
        isReadOnly: () => readonly, getScale: () => 2,
        pause: () => calls.push("pause"), resume: () => calls.push("resume"),
        onActiveChange: (active) => calls.push(String(active)),
        requestFrame: (callback) => { scheduled = callback; return 1; }, cancelFrame: () => { scheduled = undefined; },
    });
    return { controller, calls, getGraph: () => graph, update: (fn: (current: WorkflowGraph) => WorkflowGraph) => { graph = fn(graph); }, readonly: () => { readonly = true; }, frame: () => { const cb = scheduled; scheduled = undefined; cb?.(0); } };
}
const pointer = (x: number, y = 0, pointerId = 1) => ({ clientX: x, clientY: y, pointerId });

test("Frame drag coalesces movement and preserves asynchronous document updates", () => {
    const f = fixture();
    f.controller.begin(f.getGraph().frames![0]!, pointer(0));
    f.controller.move(pointer(20));
    f.controller.move(pointer(40));
    f.frame();
    assert.equal(f.getGraph().nodes[0]!.position.x, 60);
    f.update((graph) => ({ ...graph, nodes: graph.nodes.map((node) => ({ ...node, text: "upload callback", height: 120 })) }));
    f.controller.move(pointer(80, 40));
    f.controller.finish(pointer(100, 40));
    assert.deepEqual(f.getGraph().nodes[0]!.position, { x: 90, y: 100 });
    assert.equal(f.getGraph().nodes[0]!.text, "upload callback");
    assert.equal(f.getGraph().nodes[0]!.height, 120);
    assert.deepEqual(f.calls, ["pause", "true", "false", "resume"]);
    f.frame();
    assert.equal(f.getGraph().nodes[0]!.position.x, 90);
});

test("Frame pointer ownership, read-only cancellation and repeated finish cannot strand history", () => {
    const f = fixture();
    const before = structuredClone(f.getGraph());
    f.controller.begin(f.getGraph().frames![0]!, pointer(0));
    f.controller.move(pointer(200, 0, 2));
    f.controller.finish(pointer(200, 0, 2));
    assert.deepEqual(f.getGraph(), before);
    f.controller.move(pointer(200));
    f.readonly();
    f.controller.finish();
    f.controller.finish();
    assert.deepEqual(f.getGraph(), before);
    assert.equal(f.controller.begin(before.frames![0]!, pointer(0)), false);
    assert.deepEqual(f.calls, ["pause", "true", "false", "resume"]);
});

test("Frame resize updates the boundary and never scales or drops members", () => {
    const f = fixture();
    const nodes = f.getGraph().nodes;
    f.controller.begin(f.getGraph().frames![0]!, pointer(0), "bottom-right");
    f.controller.finish(pointer(200, 100));
    assert.equal(f.getGraph().frames![0]!.width, 580);
    assert.equal(f.getGraph().frames![0]!.height, 370);
    assert.deepEqual(f.getGraph().nodes, nodes);
});

test("dragging a side ignores movement on the other axis", () => {
    const f = fixture();
    const beforeNodes = f.getGraph().nodes;
    f.controller.begin(f.getGraph().frames![0]!, pointer(0), "right");
    f.controller.finish(pointer(200,100));
    assert.deepEqual(f.getGraph().frames![0]!.position,{x:0,y:0});
    assert.equal(f.getGraph().frames![0]!.width,580);
    assert.equal(f.getGraph().frames![0]!.height,320);
    assert.equal(f.getGraph().nodes,beforeNodes);
});
