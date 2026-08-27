import assert from "node:assert/strict";
import test from "node:test";

import { finishCanvasPan, type CanvasPanState } from "./infinite-canvas.tsx";

test("finishing a middle-button pan always clears the dragging state", () => {
    const state: CanvasPanState = { isPanning: true, startX: 10, startY: 20, initialX: 0, initialY: 0, hasMoved: true };
    let deselects = 0;

    assert.equal(finishCanvasPan(state, () => deselects++), true);
    assert.equal(state.isPanning, false);
    assert.equal(deselects, 0);
});

test("finishing an unmoved pan deselects once and remains idempotent", () => {
    const state: CanvasPanState = { isPanning: true, startX: 10, startY: 20, initialX: 0, initialY: 0, hasMoved: false };
    let deselects = 0;

    assert.equal(finishCanvasPan(state, () => deselects++), true);
    assert.equal(finishCanvasPan(state, () => deselects++), false);
    assert.equal(deselects, 1);
});
