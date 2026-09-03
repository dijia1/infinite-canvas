import assert from "node:assert/strict";
import test from "node:test";

import { buildCanvasViewportDebugSnapshot, isLocalCanvasViewportDebugEnabled } from "./canvas-viewport-debug";

test("reports actual scene drift separately from the 64px culling bounds", () => {
    const snapshot = buildCanvasViewportDebugSnapshot({
        sceneViewport: { x: 350, y: -120, k: 0.5 },
        cullingViewport: { x: 320, y: -100, k: 0.5 },
        viewportSize: { width: 1000, height: 500 },
        renderedNodeCount: 12,
        renderedConnectionCount: 8,
    });

    assert.deepEqual(snapshot.drift, { x: 30, y: -20, scalePercent: 0 });
    assert.deepEqual(snapshot.cullingBounds, { left: -768, top: 72, right: 1488, bottom: 1328 });
    assert.equal(snapshot.renderedNodeCount, 12);
    assert.equal(snapshot.renderedConnectionCount, 8);
    assert.equal(snapshot.screenPadding, 64);
});

test("only enables the viewport overlay on localhost with the explicit query flag", () => {
    assert.equal(isLocalCanvasViewportDebugEnabled({ hostname: "127.0.0.1", search: "?canvas-debug=1" }), true);
    assert.equal(isLocalCanvasViewportDebugEnabled({ hostname: "localhost", search: "?canvas-debug=1&foo=bar" }), true);
    assert.equal(isLocalCanvasViewportDebugEnabled({ hostname: "semetaloa.com", search: "?canvas-debug=1" }), false);
    assert.equal(isLocalCanvasViewportDebugEnabled({ hostname: "127.0.0.1", search: "?canvas-debug=0" }), false);
});
