import assert from "node:assert/strict";
import test from "node:test";

import { isCanvasNodeNearViewport } from "./canvas-node-visibility.ts";
import { CanvasNodeType, type CanvasNodeData } from "../types.ts";

function node(x: number): CanvasNodeData {
    return { id: `node-${x}`, type: CanvasNodeType.Image, title: "图片", position: { x, y: 100 }, width: 100, height: 100 };
}

test("uses screen-space padding when deciding whether to render a node", () => {
    const viewport = { x: 0, y: 0, k: 0.29 };
    const size = { width: 800, height: 600 };

    assert.equal(isCanvasNodeNearViewport(node(2950), viewport, size), true);
    assert.equal(isCanvasNodeNearViewport(node(3000), viewport, size), false);
});

test("uses the same padded boundary on all four sides", () => {
    const viewport = { x: 0, y: 0, k: 0.27 };
    const size = { width: 1256, height: 632 };

    assert.equal(isCanvasNodeNearViewport(node(-337.037037037037), viewport, size), true);
    assert.equal(isCanvasNodeNearViewport(node(-338.037037037037), viewport, size), false);
    assert.equal(isCanvasNodeNearViewport(node(4888.888888888889), viewport, size), true);
    assert.equal(isCanvasNodeNearViewport(node(4889.888888888889), viewport, size), false);

    const top = { ...node(0), position: { x: 0, y: -337.037037037037 } };
    const aboveTop = { ...top, position: { x: 0, y: -338.037037037037 } };
    const bottom = { ...node(0), position: { x: 0, y: 2577.7777777777774 } };
    const belowBottom = { ...bottom, position: { x: 0, y: 2578.7777777777774 } };

    assert.equal(isCanvasNodeNearViewport(top, viewport, size), true);
    assert.equal(isCanvasNodeNearViewport(aboveTop, viewport, size), false);
    assert.equal(isCanvasNodeNearViewport(bottom, viewport, size), true);
    assert.equal(isCanvasNodeNearViewport(belowBottom, viewport, size), false);
});
