import assert from "node:assert/strict";
import test from "node:test";

import { isCanvasConnectionNearViewport, shouldRenderCanvasConnection } from "./canvas-connection-visibility.ts";

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

test("uses the 64 pixel screen-space padding so a connection near the edge remains visible at low zoom", () => {
    assert.equal(
        isCanvasConnectionNearViewport(
            { position: { x: 2800, y: 100 }, width: 100, height: 100 },
            { position: { x: 3000, y: 100 }, width: 100, height: 100 },
            { x: 0, y: 0, k: 0.29 },
            viewportSize,
        ),
        true,
    );
    assert.equal(
        isCanvasConnectionNearViewport(
            { position: { x: 3000, y: 100 }, width: 100, height: 100 },
            { position: { x: 3200, y: 100 }, width: 100, height: 100 },
            { x: 0, y: 0, k: 0.29 },
            viewportSize,
        ),
        false,
    );
});

test("hides a normal connection when either endpoint node is not rendered", () => {
    const connection = { id: "connection-1", fromNodeId: "source", toNodeId: "target" };

    assert.equal(shouldRenderCanvasConnection(connection, new Set(["source", "target"])), true);
    assert.equal(shouldRenderCanvasConnection(connection, new Set(["source"])), false);
    assert.equal(shouldRenderCanvasConnection(connection, new Set(["target"])), false);
});

test("keeps an interactive connection even when its nodes are outside the render set", () => {
    const connection = { id: "connection-1", fromNodeId: "source", toNodeId: "target" };

    assert.equal(shouldRenderCanvasConnection(connection, new Set(), true), true);
});
