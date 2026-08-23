import assert from "node:assert/strict";
import test from "node:test";

import { getConnectionCurve, sampleConnectionPoints, segmentHitsConnection } from "./canvas-connection-geometry.ts";
import { CanvasNodeType, type CanvasNodeData } from "../types";

function node(id: string, x: number, y: number): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x, y },
        width: 100,
        height: 80,
    };
}

const from = node("from", 0, 0);
const to = node("to", 300, 100);

test("builds a stable Bezier curve between two nodes", () => {
    assert.deepEqual(getConnectionCurve(from, to), {
        start: { x: 100, y: 40 },
        control1: { x: 200, y: 40 },
        control2: { x: 200, y: 140 },
        end: { x: 300, y: 140 },
        pathD: "M 100 40 C 200 40, 200 140, 300 140",
    });
});

test("samples the curve including both endpoints", () => {
    const points = sampleConnectionPoints(from, to, 4);

    assert.equal(points.length, 5);
    assert.deepEqual(points[0], { x: 100, y: 40 });
    assert.deepEqual(points.at(-1), { x: 300, y: 140 });
});

test("detects a cut segment crossing a connection", () => {
    assert.equal(segmentHitsConnection({ x: 200, y: 0 }, { x: 200, y: 200 }, from, to, 1), true);
});

test("does not detect a distant cut segment", () => {
    assert.equal(segmentHitsConnection({ x: 0, y: 0 }, { x: 0, y: 200 }, from, to, 1), false);
});
