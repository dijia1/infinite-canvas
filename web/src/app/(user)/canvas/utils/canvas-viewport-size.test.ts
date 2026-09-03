import assert from "node:assert/strict";
import test from "node:test";

import { getCanvasViewportSize } from "./canvas-viewport-size";

test("uses the current canvas rect instead of an earlier fallback size", () => {
    assert.deepEqual(
        getCanvasViewportSize(
            {
                getBoundingClientRect: () => ({ width: 1920, height: 864 }),
            } as HTMLElement,
            { width: 1200, height: 720 },
        ),
        { width: 1920, height: 864 },
    );
});

test("keeps the fallback while the canvas has not been laid out", () => {
    assert.deepEqual(
        getCanvasViewportSize(
            {
                getBoundingClientRect: () => ({ width: 0, height: 0 }),
            } as HTMLElement,
            { width: 1200, height: 720 },
        ),
        { width: 1200, height: 720 },
    );
});
