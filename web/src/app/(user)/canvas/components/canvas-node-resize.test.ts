import assert from "node:assert/strict";
import test from "node:test";

import { sourceBehavior } from "@/test-utils/source-behavior";
import { CanvasNodeType, type CanvasNodeData } from "../types";

function startResize(type: CanvasNodeType, compact = false, freeResize = false) {
    const resizeRef = { current: {} as Record<string, unknown> };
    const data: CanvasNodeData = { id: "node", type, title: "Node", position: { x: 20, y: 40 }, width: 400, height: 300, metadata: { naturalWidth: 1920, naturalHeight: 1080, freeResize } };
    const start = sourceBehavior(new URL("./canvas-node.tsx", import.meta.url), {
        resizeRef, data, configCard: compact ? { form: "controls" } : undefined,
        CanvasNodeType, onResizeStart() {}, handleResizeMove() {}, handleResizeUp() {},
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
        assert.deepEqual(state.minimum, compact ? undefined : { width: 220, height: 274 });
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
