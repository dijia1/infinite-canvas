import assert from "node:assert/strict";
import test from "node:test";

import { adjustMaskBrushSize, DEFAULT_BRUSH_SIZE, maskBrushKeyDelta, maskBrushRadius } from "./mask-brush";

const key = { key: "[", code: "BracketLeft", ctrlKey: false, metaKey: false, altKey: false, isComposing: false };

test("both brush tools use bracket steps and stop at size limits", () => {
    assert.equal(DEFAULT_BRUSH_SIZE, 24);
    assert.equal(adjustMaskBrushSize(24, maskBrushKeyDelta(key)), 20);
    assert.equal(adjustMaskBrushSize(24, maskBrushKeyDelta({ ...key, key: "]", code: "BracketRight" })), 28);
    assert.equal(adjustMaskBrushSize(8, -4), 8);
    assert.equal(adjustMaskBrushSize(80, 4), 80);
    assert.equal(adjustMaskBrushSize(79, 4), 80);
});

test("brush shortcuts ignore IME, command, control and option combinations", () => {
    for (const flag of ["ctrlKey", "metaKey", "altKey", "isComposing"] as const) assert.equal(maskBrushKeyDelta({ ...key, [flag]: true }), 0);
    assert.equal(maskBrushKeyDelta({ ...key, key: "a", code: "KeyA" }), 0);
    assert.equal(maskBrushKeyDelta({ ...key, key: "【" }), -4);
});

test("cursor and normalized strokes agree on CSS pixel diameter across image sizes", () => {
    for (const [width, height] of [[640, 480], [250.5, 700], [1200, 800]]) {
        const radius = maskBrushRadius(24, width, height);
        assert.ok(Math.abs(radius * Math.min(width, height) * 2 - 24) < 0.00001);
    }
    assert.equal(maskBrushRadius(80, 10, 20), 0.5);
});
