import assert from "node:assert/strict";
import test from "node:test";

import { getCanvasViewportBounds, intersectsCanvasViewportBounds } from "./canvas-viewport-bounds.ts";

test("converts the 64 pixel render buffer into world coordinates", () => {
    const bounds = getCanvasViewportBounds({ x: 0, y: 0, k: 0.29 }, { width: 800, height: 600 }, 64);

    assert.ok(Math.abs(bounds.left + 220.69) < 0.01);
    assert.ok(Math.abs(bounds.right - 2979.31) < 0.01);
});

test("keeps a node within 64 screen pixels beyond the right edge mounted at 29 percent zoom", () => {
    const bounds = getCanvasViewportBounds({ x: 0, y: 0, k: 0.29 }, { width: 800, height: 600 }, 64);

    assert.equal(intersectsCanvasViewportBounds({ left: 2950, top: 100, right: 3050, bottom: 200 }, bounds), true);
    assert.equal(intersectsCanvasViewportBounds({ left: 3000, top: 100, right: 3100, bottom: 200 }, bounds), false);
});
