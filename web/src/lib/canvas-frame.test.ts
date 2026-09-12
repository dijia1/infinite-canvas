import assert from "node:assert/strict";
import test from "node:test";

import { canvasFrameBounds, canvasFrameContainsRect, canvasFrameRectsOverlap, constrainCanvasFrameDelta, constrainCanvasFrameTransition, expandCanvasFrame, resizeCanvasFrame, resizeCanvasFrameFromHandle, setFrameMembers, type CanvasFrameData, type CanvasFrameResizeDirection } from "./canvas-frame";

const frame = (id: string, nodeIds: string[] = []): CanvasFrameData => ({
    id,
    name: id.toUpperCase(),
    position: { x: 0, y: 0 },
    width: 600,
    height: 400,
    nodeIds,
});

test("setFrameMembers atomically transfers unique members without mutating input", () => {
    const first = frame("a", ["n", "kept"]);
    const second = frame("b");

    const next = setFrameMembers([first, second], ["n", "n"], "b");

    assert.deepEqual(
        next.map((item) => item.nodeIds),
        [["kept"], ["n"]],
    );
    assert.deepEqual(first.nodeIds, ["n", "kept"]);
    assert.equal(setFrameMembers(next, ["n"], "b"), next);
    assert.equal(setFrameMembers(next, ["n"], "missing"), next);
});

test("rejoining an existing member preserves target ordering and returns the original array", () => {
    const frames = [frame("a"), frame("b", ["n", "other"])];
    assert.equal(setFrameMembers(frames, ["n"], "b"), frames);
});

test("canvasFrameBounds reserves header and padding around world-coordinate rectangles", () => {
    assert.deepEqual(
        canvasFrameBounds([
            { position: { x: 100, y: 80 }, width: 200, height: 100 },
            { position: { x: 360, y: 40 }, width: 80, height: 260 },
        ]),
        { position: { x: 76, y: -28 }, width: 388, height: 352 },
    );
    assert.equal(canvasFrameBounds([]), null);
});

test("expansion only grows bounds and returns the same object when members already fit", () => {
    const original = frame("a", ["n"]);
    assert.equal(expandCanvasFrame(original, [{ position: { x: 100, y: 100 }, width: 100, height: 100 }]), original);
    assert.deepEqual(expandCanvasFrame(original, [{ position: { x: 580, y: 380 }, width: 100, height: 100 }]), {
        ...original,
        width: 704,
        height: 504,
    });
});

test("resizing preserves the padded member bounds and never moves a member", () => {
    const original = frame("a", ["n"]);
    const resized = resizeCanvasFrame(original, { position: { x: 150, y: 150 }, width: 100, height: 100 }, [{ position: { x: 100, y: 80 }, width: 200, height: 100 }]);
    assert.deepEqual(resized, { ...original, position: { x: 76, y: 12 }, width: 314, height: 298 });
    assert.deepEqual(original.position, { x: 0, y: 0 });
});

test("edge handles keep the opposite edge fixed and enforce the Frame minimum", () => {
    const original = { ...frame("a"), position: { x: 100, y: 80 }, width: 400, height: 300 };
    const cases: Array<[CanvasFrameResizeDirection, { x: number; y: number }, CanvasFrameData]> = [
        ["top", { x: 999, y: 250 }, { ...original, position: { x: 100, y: 220 }, width: 400, height: 160 }],
        ["right", { x: -300, y: 999 }, { ...original, width: 240 }],
        ["bottom", { x: 999, y: -250 }, { ...original, height: 160 }],
        ["left", { x: 300, y: 999 }, { ...original, position: { x: 260, y: 80 }, width: 240 }],
    ];

    for (const [direction, delta, expected] of cases) {
        assert.deepEqual(resizeCanvasFrameFromHandle(original, direction, delta, []), expected, direction);
    }
});

test("corner handles stop at padded member bounds without moving their opposite edges", () => {
    const original = frame("a", ["n"]);
    const memberRects = [{ position: { x: 100, y: 80 }, width: 200, height: 100 }];

    assert.deepEqual(resizeCanvasFrameFromHandle(original, "top-left", { x: 200, y: 200 }, memberRects), {
        ...original,
        position: { x: 76, y: 12 },
        width: 524,
        height: 388,
    });
    assert.deepEqual(resizeCanvasFrameFromHandle(original, "top-right", { x: -500, y: 200 }, memberRects), {
        ...original,
        position: { x: 0, y: 12 },
        width: 324,
        height: 388,
    });
});

test("rectangle containment includes shared boundaries and rejects partial inclusion", () => {
    const container = { position: { x: 10, y: 20 }, width: 300, height: 200 };

    assert.equal(canvasFrameContainsRect(container, { position: { x: 10, y: 20 }, width: 300, height: 200 }), true);
    assert.equal(canvasFrameContainsRect(container, { position: { x: 20, y: 30 }, width: 40, height: 50 }), true);
    assert.equal(canvasFrameContainsRect(container, { position: { x: 9, y: 30 }, width: 40, height: 50 }), false);
});

test("strict rectangle overlap allows edge and corner contact", () => {
    const first = { position: { x: 0, y: 0 }, width: 100, height: 100 };

    assert.equal(canvasFrameRectsOverlap(first, { position: { x: 99, y: 20 }, width: 100, height: 40 }), true);
    assert.equal(canvasFrameRectsOverlap(first, { position: { x: 100, y: 20 }, width: 100, height: 40 }), false);
    assert.equal(canvasFrameRectsOverlap(first, { position: { x: 100, y: 100 }, width: 100, height: 40 }), false);
});

test("frame transition stops at the first blocker contact even when the requested move passes through", () => {
    const start = { position: { x: 0, y: 0 }, width: 100, height: 100 };
    const requested = { ...start, position: { x: 300, y: 0 } };
    const blocker = { position: { x: 200, y: 20 }, width: 100, height: 100 };

    assert.deepEqual(constrainCanvasFrameTransition(start, requested, [blocker]), { ...start, position: { x: 100, y: 0 } });
    assert.deepEqual(constrainCanvasFrameDelta(start, { x: 300, y: 0 }, [blocker]), { x: 100, y: 0 });
});

test("frame transition constrains moving resize edges and preserves unrestricted candidates", () => {
    const start = { position: { x: 0, y: 0 }, width: 100, height: 100 };
    const blocker = { position: { x: 200, y: 20 }, width: 100, height: 60 };
    const safe = { position: { x: 0, y: 0 }, width: 150, height: 100 };

    assert.equal(constrainCanvasFrameTransition(start, safe, [blocker]), safe);
    assert.deepEqual(constrainCanvasFrameTransition(start, { ...start, width: 300 }, [blocker]), { ...start, width: 200 });
});
