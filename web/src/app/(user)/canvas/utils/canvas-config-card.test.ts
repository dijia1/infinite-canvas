import assert from "node:assert/strict";
import test from "node:test";

import { getConfigCardDisplayScale, getConfigCardFloorLimits, getConfigCardView } from "./canvas-config-card";
import { CanvasNodeType, type CanvasNodeData } from "../types";

function card(id: string, x: number, y: number, width = 360, height = 274): CanvasNodeData {
    return { id, type: CanvasNodeType.Config, title: id, position: { x, y }, width, height };
}

function screenWidth(node: CanvasNodeData, zoom: number, nodes: CanvasNodeData[]) {
    return node.width * zoom * getConfigCardDisplayScale(node, zoom, getConfigCardFloorLimits(nodes).get(node.id));
}

function formAt(node: CanvasNodeData, zoom: number, nodes: CanvasNodeData[]) {
    return getConfigCardView(node, zoom, getConfigCardFloorLimits(nodes).get(node.id))?.form;
}

test("a card without nearby config cards keeps the controls form at its floor", () => {
    const only = card("a", 0, 0);
    for (const zoom of [0.3, 0.1, 0.05]) {
        assert.equal(Math.round(screenWidth(only, zoom, [only])), 176);
        assert.equal(formAt(only, zoom, [only]), "controls");
    }
    assert.equal(Math.round(screenWidth(only, 0.5, [only])), 180);
});

test("cards spaced for large images keep the controls form until they would collide", () => {
    const left = card("left", 0, 0);
    const right = card("right", 2560, 0);
    const limits = getConfigCardFloorLimits([left, right]).get("left")!;
    assert.ok(Math.abs(limits.controls - 176 / 2560) < 1e-4);
    assert.equal(Math.round(screenWidth(left, 0.07, [left, right])), 176);
    assert.equal(formAt(left, 0.07, [left, right]), "controls");
    assert.equal(Math.round(screenWidth(left, 0.05, [left, right])), 68);
    assert.equal(formAt(left, 0.05, [left, right]), "icons");
});

test("densely stacked cards switch straight to icons, then shrink with the canvas", () => {
    const top = card("top", 0, 0);
    const bottom = card("bottom", 0, 420);
    const limits = getConfigCardFloorLimits([top, bottom]).get("top")!;
    assert.ok(Math.abs(limits.controls - 0.319) < 0.001);
    assert.ok(Math.abs(limits.icons - 0.1233) < 0.001);
    assert.equal(formAt(top, 0.33, [top, bottom]), "controls");
    assert.equal(Math.round(screenWidth(top, 0.33, [top, bottom])), 176);
    // Above the icon floor the icons scale with the card, so there is no intermediate layout.
    assert.equal(formAt(top, 0.3, [top, bottom]), "icons");
    assert.equal(Math.round(screenWidth(top, 0.3, [top, bottom])), 108);
    assert.equal(Math.round(screenWidth(top, 0.14, [top, bottom])), 68);
    assert.equal(Math.round(screenWidth(top, 0.1, [top, bottom])), 36);
    assert.equal(formAt(top, 0.05, [top, bottom]), "icons");
});

test("a form's design scale does not depend on zoom, so its layout never reflows", () => {
    const only = card("a", 0, 0);
    const limits = getConfigCardFloorLimits([only]).get("a");
    const scales = [0.79, 0.6, 0.5, 0.3, 0.1].map((zoom) => getConfigCardView(only, zoom, limits)?.designScale);
    assert.equal(new Set(scales).size, 1);
});

test("the card renders at world size once the canvas passes the compact threshold", () => {
    const narrow = card("narrow", 0, 0, 220, 160);
    const limits = getConfigCardFloorLimits([narrow]).get("narrow");
    assert.equal(getConfigCardDisplayScale(narrow, 0.8, limits), 1);
    assert.ok(getConfigCardDisplayScale(narrow, 0.79, limits) > 1);
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
    assert.equal(getConfigCardView(image, 0.1, limits.get("image")), undefined);
    assert.equal(getConfigCardDisplayScale(image, 0.1, limits.get("image")), 1);
    // A wide card still reaches the height its controls need.
    assert.equal(Math.round(getConfigCardView(wide, 0.1, limits.get("wide"))!.floorScale * wide.height), 134);
});
