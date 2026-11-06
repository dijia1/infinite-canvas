import assert from "node:assert/strict";
import test from "node:test";

import { sourceBehavior } from "@/test-utils/source-behavior";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { CONFIG_NODE_MIN_SIZE } from "../utils/canvas-config-card";
import { resizeCanvasNode } from "@/lib/canvas-resize";

function startResize(type: CanvasNodeType, compact = false, freeResize = false) {
    const resizeRef = { current: {} as Record<string, unknown> };
    const data: CanvasNodeData = { id: "node", type, title: "Node", position: { x: 20, y: 40 }, width: 400, height: 300, metadata: { naturalWidth: 1920, naturalHeight: 1080, freeResize } };
    const start = sourceBehavior(new URL("./canvas-node.tsx", import.meta.url), {
        resizeRef, data, configCard: compact ? { form: "controls" } : undefined,
        CanvasNodeType, CONFIG_NODE_MIN_SIZE, onResizeStart() {}, handleResizeMove() {}, handleResizeUp() {},
        window: { addEventListener() {} },
    }).named("handleResizeMouseDown");
    start({ clientX: 10, clientY: 30, stopPropagation() {}, preventDefault() {}, currentTarget: { closest: () => ({ querySelector: () => ({ offsetHeight: 270 }) }) } }, "top-left");
    return resizeRef.current;
}

test("config resizing locks the current node ratio in both layouts, independently of media metadata", () => {
    for (const compact of [false, true]) {
        const state = startResize(CanvasNodeType.Config, compact);
        assert.equal(state.keepRatio, true);
        assert.equal(state.ratio, 4 / 3);
        assert.deepEqual(state.minimum, { width: 360, height: 274 });
    }
});

test("full and compact cards stop at the same minimum without changing their aspect ratio or opposite corner", () => {
    for (const size of [{ width: 720, height: 548 }, { width: 400, height: 500 }]) {
        for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
            const results = [false, true].map((compact) => {
                const { minimum } = startResize(CanvasNodeType.Config, compact);
                return resizeCanvasNode({ ...size, x: 40, y: 80, corner, keepRatio: true, ratio: size.width / size.height }, { x: corner.includes("left") ? 2000 : -2000, y: corner.includes("top") ? 2000 : -2000 }, minimum as typeof CONFIG_NODE_MIN_SIZE);
            });
            assert.deepEqual(results[0], results[1]);
            const result = results[0]!;
            assert.ok(result.width >= 360 && result.height >= 274);
            assert.ok(Math.abs(result.width / result.height - size.width / size.height) < 1e-9);
            assert.equal(result.position.x + (corner.includes("left") ? result.width : 0), 40 + (corner.includes("left") ? size.width : 0));
            assert.equal(result.position.y + (corner.includes("top") ? result.height : 0), 80 + (corner.includes("top") ? size.height : 0));
        }
    }
});

test("image, video and text nodes keep their existing resize behavior", () => {
    assert.equal(startResize(CanvasNodeType.Image).keepRatio, true);
    assert.equal(startResize(CanvasNodeType.Image).ratio, 16 / 9);
    assert.equal(startResize(CanvasNodeType.Image, false, true).keepRatio, false);
    assert.equal(startResize(CanvasNodeType.Video).keepRatio, true);
    assert.equal(startResize(CanvasNodeType.Text).keepRatio, false);
    assert.equal(startResize(CanvasNodeType.Text).minimum, undefined);
});
