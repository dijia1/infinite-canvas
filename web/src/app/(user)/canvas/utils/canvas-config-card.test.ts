import assert from "node:assert/strict";
import test from "node:test";

import { getConfigCardDisplayScale, getConfigCardFloorLimits, getConfigCardFloorScale } from "./canvas-config-card";
import { CanvasNodeType, type CanvasNodeData } from "../types";

function card(id: string, x: number, y: number, width = 360, height = 274): CanvasNodeData {
    return { id, type: CanvasNodeType.Config, title: id, position: { x, y }, width, height };
}

function screenWidth(node: CanvasNodeData, zoom: number, nodes: CanvasNodeData[]) {
    return node.width * zoom * getConfigCardDisplayScale(node, zoom, getConfigCardFloorLimits(nodes).get(node.id));
}

test("a card without nearby config cards keeps its control floor at every zoom", () => {
    const only = card("a", 0, 0);
    for (const zoom of [0.3, 0.1, 0.05]) assert.equal(Math.round(screenWidth(only, zoom, [only])), 136);
    assert.equal(Math.round(screenWidth(only, 0.5, [only])), 180);
});

test("cards spaced for large images keep three rows until they would collide", () => {
    const left = card("left", 0, 0);
    const right = card("right", 2560, 0);
    const limits = getConfigCardFloorLimits([left, right]).get("left")!;
    assert.ok(Math.abs(limits.controls - 136 / 2560) < 1e-9);
    assert.equal(Math.round(screenWidth(left, 0.06, [left, right])), 136);
    assert.equal(Math.round(screenWidth(left, 0.05, [left, right])), 68);
});

test("densely stacked cards fall back to icons, then shrink with the canvas", () => {
    const top = card("top", 0, 0);
    const bottom = card("bottom", 0, 420);
    const limits = getConfigCardFloorLimits([top, bottom]).get("top")!;
    assert.ok(Math.abs(limits.controls - 0.2467) < 0.001);
    assert.ok(Math.abs(limits.icons - 0.1233) < 0.001);
    assert.equal(Math.round(screenWidth(top, 0.25, [top, bottom])), 136);
    assert.equal(Math.round(screenWidth(top, 0.14, [top, bottom])), 68);
    assert.equal(Math.round(screenWidth(top, 0.1, [top, bottom])), 36);
});

test("floored cards never overlap another config card at any zoom", () => {
    const cards = [card("a", 0, 0), card("b", 400, 40), card("c", 300, 500), card("d", 2600, 0), card("e", 2700, 2400)];
    const limits = getConfigCardFloorLimits(cards);
    const rect = (node: CanvasNodeData, zoom: number) => {
        const scale = getConfigCardDisplayScale(node, zoom, limits.get(node.id));
        const centerX = (node.position.x + node.width / 2) * zoom;
        const centerY = (node.position.y + node.height / 2) * zoom;
        const width = node.width * zoom * scale;
        const height = node.height * zoom * scale;
        return { left: centerX - width / 2, right: centerX + width / 2, top: centerY - height / 2, bottom: centerY + height / 2 };
    };
    for (let zoom = 0.05; zoom < 0.8; zoom += 0.01) {
        for (const a of cards) for (const b of cards) {
            if (a === b) continue;
            const ra = rect(a, zoom);
            const rb = rect(b, zoom);
            const overlaps = ra.left < rb.right - 0.01 && rb.left < ra.right - 0.01 && ra.top < rb.bottom - 0.01 && rb.top < ra.bottom - 0.01;
            assert.equal(overlaps, false, `${a.id} overlaps ${b.id} at zoom ${zoom.toFixed(2)}`);
        }
    }
});

test("non-config nodes and wide cards are handled by their own geometry", () => {
    const image: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "image", position: { x: 10, y: 10 }, width: 1800, height: 1800 };
    const wide = card("wide", 0, 0, 720, 274);
    const limits = getConfigCardFloorLimits([image, wide]);
    assert.equal(limits.has("image"), false);
    assert.equal(getConfigCardDisplayScale(image, 0.1, limits.get("image")), 1);
    // A wide card still reaches the height needed for three rows.
    assert.equal(Math.round(getConfigCardFloorScale(wide, 0.1, limits.get("wide")) * wide.height), 102);
});
