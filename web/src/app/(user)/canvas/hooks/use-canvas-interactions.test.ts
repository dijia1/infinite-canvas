import assert from "node:assert/strict";
import test from "node:test";

import { applyNodeDragPositions, createCanvasInteractionController } from "./use-canvas-interactions.ts";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ViewportTransform } from "../types.ts";

type Ref<T> = { current: T };

function ref<T>(current: T): Ref<T> {
    return { current };
}

function imageNode(id: string, x: number, y: number, metadata?: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x, y }, width: 100, height: 100, metadata };
}

function setup(
    initialNodes: CanvasNodeData[],
    initialConnections: CanvasConnection[] = [],
    options: {
        deferConnectionUpdates?: boolean;
        onNodeDragStart?: (event: { nodeIds: ReadonlySet<string>; altKey: boolean }) => void;
        onNodeDragEnd?: (event: { nodeIds: ReadonlySet<string>; altKey: boolean; cancelled: boolean }) => void;
        constrainNodeDrag?: (event: { delta: { x: number; y: number }; altKey: boolean }) => { x: number; y: number };
    } = {},
) {
    const nodesRef = ref(initialNodes);
    const connectionsRef = ref(initialConnections);
    const selectedNodeIdsRef = ref(new Set<string>());
    const viewportRef = ref<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const calls: string[] = [];
    let frame: FrameRequestCallback | null = null;
    let deferredConnectionUpdate: ((connections: CanvasConnection[]) => CanvasConnection[]) | null = null;

    const controller = createCanvasInteractionController({
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        setNodes: (next) => {
            nodesRef.current = typeof next === "function" ? next(nodesRef.current) : next;
        },
        setConnections: (next) => {
            const update = typeof next === "function" ? next : () => next;
            if (options.deferConnectionUpdates) {
                deferredConnectionUpdate = update;
                return;
            }
            connectionsRef.current = update(connectionsRef.current);
        },
        setSelectedNodeIds: (next) => {
            selectedNodeIdsRef.current = typeof next === "function" ? next(selectedNodeIdsRef.current) : next;
        },
        setSelectedConnectionId: () => undefined,
        setContextMenu: () => undefined,
        setHoveredNodeId: () => undefined,
        setToolbarNodeId: () => undefined,
        setDialogNodeId: () => undefined,
        pause: () => calls.push("pause"),
        resume: () => calls.push("resume"),
        screenToCanvas: (x, y) => ({ x, y }),
        createNode: (type, position) => ({ id: `new-${type}`, type, title: type, position, width: 100, height: 100 }),
        requestAnimationFrame: (callback) => {
            frame = callback;
            return 1;
        },
        cancelAnimationFrame: () => {
            frame = null;
        },
        onNodeDragStart: options.onNodeDragStart,
        onNodeDragEnd: options.onNodeDragEnd,
        constrainNodeDrag: options.constrainNodeDrag,
    });

    return {
        controller,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        calls,
        flushFrame: () => frame?.(0),
        flushDeferredConnectionUpdate: () => {
            if (deferredConnectionUpdate) connectionsRef.current = deferredConnectionUpdate(connectionsRef.current);
        },
    };
}

test("node drag lifecycle latches Alt, starts after movement, and finishes before history resumes", () => {
    const events: string[] = [];
    const { controller, calls, flushFrame } = setup([imageNode("first", 0, 0)], [], {
        onNodeDragStart: ({ nodeIds, altKey }) => events.push(`start:${[...nodeIds].join(",")}:${altKey}`),
        onNodeDragEnd: ({ nodeIds, altKey, cancelled }) => events.push(`end:${[...nodeIds].join(",")}:${altKey}:${cancelled}`),
    });

    controller.handleNodeMouseDown({ clientX: 10, clientY: 10, altKey: true }, "first");
    assert.deepEqual(events, []);
    controller.handleGlobalMouseMove({ clientX: 20, clientY: 10, altKey: false });
    flushFrame();
    controller.finishNodeDrag(20, 10);

    assert.deepEqual(events, ["start:first:true", "end:first:true:false"]);
    assert.deepEqual(calls, ["pause", "resume"]);
});

test("cancelled node drag reports cancellation before history resumes", () => {
    const order: string[] = [];
    const { controller, flushFrame } = setup([imageNode("first", 0, 0)], [], {
        onNodeDragStart: () => order.push("start"),
        onNodeDragEnd: ({ cancelled }) => order.push(cancelled ? "cancel" : "finish"),
    });

    controller.handleNodeMouseDown({ clientX: 10, clientY: 10, altKey: true }, "first");
    controller.handleGlobalMouseMove({ clientX: 20, clientY: 10 });
    flushFrame();
    controller.cancelNodeDrag();

    assert.deepEqual(order, ["start", "cancel"]);
});

test("disposing an active node drag reports cancellation before clearing interaction state", () => {
    const order: string[] = [];
    const { controller, calls, flushFrame } = setup([imageNode("first", 0, 0)], [], {
        onNodeDragStart: () => order.push("start"),
        onNodeDragEnd: ({ cancelled }) => order.push(cancelled ? "cancel" : "finish"),
    });

    controller.handleNodeMouseDown({ clientX: 10, clientY: 10, altKey: true }, "first");
    controller.handleGlobalMouseMove({ clientX: 20, clientY: 10 });
    flushFrame();
    controller.dispose();

    assert.deepEqual(order, ["start", "cancel"]);
    assert.deepEqual(calls, ["pause", "resume"]);
    assert.equal(controller.isNodeDragging, false);
});

test("a drag completion callback failure cannot strand history or dragging state", () => {
    const { controller, calls, flushFrame } = setup([imageNode("first", 0, 0)], [], {
        onNodeDragEnd: () => {
            throw new Error("completion failed");
        },
    });

    controller.handleNodeMouseDown({ clientX: 0, clientY: 0 }, "first");
    controller.handleGlobalMouseMove({ clientX: 20, clientY: 0 });
    flushFrame();

    assert.throws(() => controller.finishNodeDrag(20, 0), /completion failed/);
    assert.deepEqual(calls, ["pause", "resume"]);
    assert.equal(controller.isNodeDragging, false);
});

test("node drag applies the caller constraint to live and committed positions", () => {
    const { controller, nodesRef, flushFrame } = setup([imageNode("first", 0, 0)], [], {
        constrainNodeDrag: ({ delta, altKey }) => (altKey ? delta : { x: Math.min(delta.x, 5), y: delta.y }),
    });

    controller.handleNodeMouseDown({ clientX: 0, clientY: 0 }, "first");
    controller.handleGlobalMouseMove({ clientX: 20, clientY: 10 });
    flushFrame();
    assert.deepEqual(nodesRef.current[0]?.position, { x: 5, y: 10 });

    controller.finishNodeDrag(30, 20);
    assert.deepEqual(nodesRef.current[0]?.position, { x: 5, y: 20 });
});

test("pointer jitter below the drag threshold does not move a node or start its lifecycle", () => {
    let starts = 0;
    const { controller, nodesRef, flushFrame } = setup([imageNode("first", 0, 0)], [], {
        onNodeDragStart: () => {
            starts += 1;
        },
    });

    controller.handleNodeMouseDown({ clientX: 10, clientY: 10 }, "first");
    controller.handleGlobalMouseMove({ clientX: 12, clientY: 12 });
    flushFrame();
    controller.finishNodeDrag(12, 12);

    assert.deepEqual(nodesRef.current[0]?.position, { x: 0, y: 0 });
    assert.equal(starts, 0);
});

test("node drag moves selected batch children and commits only after pointer release", () => {
    const root = imageNode("root", 0, 0, { batchChildIds: ["child"] });
    const child = imageNode("child", 20, 30, { batchRootId: "root" });
    const { controller, nodesRef, selectedNodeIdsRef, calls, flushFrame } = setup([root, child]);

    controller.handleNodeMouseDown({ clientX: 10, clientY: 10 }, "root");
    controller.handleGlobalMouseMove({ clientX: 40, clientY: 50 });
    assert.deepEqual(
        nodesRef.current.map((node) => node.position),
        [
            { x: 0, y: 0 },
            { x: 20, y: 30 },
        ],
    );

    flushFrame();
    assert.deepEqual(
        nodesRef.current.map((node) => node.position),
        [
            { x: 30, y: 40 },
            { x: 50, y: 70 },
        ],
    );
    controller.finishNodeDrag(40, 50);

    assert.deepEqual(calls, ["pause", "resume"]);
    assert.deepEqual(selectedNodeIdsRef.current, new Set(["root"]));
});

test("node drag uses indexed initial positions for a multi-selection", () => {
    const first = imageNode("first", 0, 0);
    const second = imageNode("second", 100, 100);
    const untouched = imageNode("untouched", 300, 300);

    const moved = applyNodeDragPositions(
        [first, second, untouched],
        new Map([
            ["first", { x: 0, y: 0 }],
            ["second", { x: 100, y: 100 }],
        ]),
        20,
        -10,
    );

    assert.deepEqual(
        moved.map((node) => node.position),
        [
            { x: 20, y: -10 },
            { x: 120, y: 90 },
            { x: 300, y: 300 },
        ],
    );
    assert.equal(moved[2], untouched);
});

test("connection creation normalizes config handles, opens pending creation, and rejects duplicates", () => {
    const config = { ...imageNode("config", 0, 0), type: CanvasNodeType.Config };
    const image = imageNode("image", 200, 0);
    const { controller, connectionsRef } = setup([config, image]);

    controller.handleConnectStart({ clientX: 0, clientY: 0 }, "config", "target");
    controller.handleGlobalMouseUp({ clientX: 240, clientY: 40 });
    assert.deepEqual(
        connectionsRef.current.map(({ fromNodeId, toNodeId }) => ({ fromNodeId, toNodeId })),
        [{ fromNodeId: "image", toNodeId: "config" }],
    );

    controller.handleConnectStart({ clientX: 0, clientY: 0 }, "config", "target");
    controller.handleGlobalMouseUp({ clientX: 240, clientY: 40 });
    assert.equal(connectionsRef.current.length, 1);

    controller.handleConnectStart({ clientX: 0, clientY: 0 }, "image", "source");
    controller.handleGlobalMouseUp({ clientX: 600, clientY: 300 });
    assert.ok(controller.pendingConnectionCreate);
    controller.createConnectedNode(CanvasNodeType.Text, controller.pendingConnectionCreate!);
    assert.equal(controller.pendingConnectionCreate, null);
    assert.equal(connectionsRef.current.length, 2);
});

test("cut mode ignores hidden batch endpoints and removes only intersected visible connections", () => {
    const from = imageNode("from", 0, 0);
    const to = imageNode("to", 300, 0);
    const batchRoot = imageNode("root", 0, 200, { imageBatchExpanded: false });
    const hidden = imageNode("hidden", 300, 200, { batchRootId: "root" });
    const connections = [
        { id: "visible", fromNodeId: "from", toNodeId: "to" },
        { id: "hidden", fromNodeId: "root", toNodeId: "hidden" },
    ];
    const { controller, connectionsRef } = setup([from, to, batchRoot, hidden], connections);

    controller.handleCanvasMouseDown({ button: 0, ctrlKey: true, shiftKey: false, clientX: 150, clientY: -20 });
    controller.handleGlobalPointerMove({ buttons: 1, clientX: 150, clientY: 120 });
    controller.finishCutConnection();

    assert.deepEqual(
        connectionsRef.current.map((connection) => connection.id),
        ["hidden"],
    );
});

test("cut completion keeps matched connection IDs after React defers the connection update", () => {
    const from = imageNode("from", 0, 0);
    const to = imageNode("to", 300, 0);
    const connections = [{ id: "visible", fromNodeId: "from", toNodeId: "to" }];
    const { controller, connectionsRef, flushDeferredConnectionUpdate } = setup([from, to], connections, { deferConnectionUpdates: true });

    controller.handleCanvasMouseDown({ button: 0, ctrlKey: true, clientX: 150, clientY: -20 });
    controller.handleGlobalPointerMove({ buttons: 1, clientX: 150, clientY: 120 });
    controller.finishCutConnection();

    assert.doesNotThrow(flushDeferredConnectionUpdate);
    assert.deepEqual(connectionsRef.current, []);
});

test("selection box supports replace and additive selection, and cleanup clears pending animation work", () => {
    const { controller, selectedNodeIdsRef } = setup([imageNode("first", 0, 0), imageNode("second", 200, 0)]);

    controller.handleCanvasMouseDown({ button: 0, ctrlKey: false, shiftKey: false, clientX: -10, clientY: -10 });
    controller.handleGlobalPointerMove({ buttons: 1, clientX: 120, clientY: 120 });
    assert.deepEqual(selectedNodeIdsRef.current, new Set(["first"]));

    controller.handleCanvasMouseDown({ button: 0, ctrlKey: false, shiftKey: true, clientX: 190, clientY: -10 });
    controller.handleGlobalPointerMove({ buttons: 1, clientX: 320, clientY: 120 });
    assert.deepEqual(selectedNodeIdsRef.current, new Set(["first", "second"]));
    controller.dispose();
    assert.equal(controller.selectionBox, null);
});

test("pointer release clears an active selection box without requiring another pointer move", () => {
    const { controller } = setup([imageNode("first", 0, 0)]);

    controller.handleCanvasMouseDown({ button: 0, ctrlKey: false, shiftKey: false, clientX: -10, clientY: -10 });
    controller.handleGlobalPointerMove({ buttons: 1, clientX: 120, clientY: 120 });
    assert.notEqual(controller.selectionBox, null);

    controller.handleGlobalPointerUp({ clientX: 120, clientY: 120 });

    assert.equal(controller.selectionBox, null);
});
