import assert from "node:assert/strict";
import test from "node:test";

import { isCanvasConnectionNearViewport } from "./canvas-connection-visibility.ts";

const viewport = { x: 0, y: 0, k: 1 };
const viewportSize = { width: 800, height: 600 };

test("keeps a connection whose curve can cross the current viewport", () => {
    assert.equal(
        isCanvasConnectionNearViewport(
            { position: { x: -900, y: 100 }, width: 120, height: 120 },
            { position: { x: 1500, y: 100 }, width: 120, height: 120 },
            viewport,
            viewportSize,
        ),
        true,
    );
});

test("culls a connection whose full padded bounds are outside the viewport", () => {
    assert.equal(
        isCanvasConnectionNearViewport(
            { position: { x: 3000, y: 3000 }, width: 120, height: 120 },
            { position: { x: 3500, y: 3400 }, width: 120, height: 120 },
            viewport,
            viewportSize,
        ),
        false,
    );
});
