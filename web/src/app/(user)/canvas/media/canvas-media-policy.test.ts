import assert from "node:assert/strict";
import test from "node:test";

import { getCanvasImageVariant } from "./canvas-media-policy.ts";

test("uses a thumbnail for a visible image whose displayed pixels are below the LOD threshold", () => {
    assert.equal(
        getCanvasImageVariant({ visible: true, width: 1024, height: 1024, scale: 0.2 }),
        "thumbnail",
    );
});

test("uses the original for a visible image whose displayed pixels exceed the LOD threshold", () => {
    assert.equal(
        getCanvasImageVariant({ visible: true, width: 1024, height: 1024, scale: 0.8 }),
        "original",
    );
});

test("keeps an original through the screen-size hysteresis band to avoid zoom flicker", () => {
    assert.equal(
        getCanvasImageVariant({ visible: true, width: 1024, height: 1024, scale: 0.55, currentVariant: "original" }),
        "original",
    );
    assert.equal(
        getCanvasImageVariant({ visible: true, width: 1024, height: 1024, scale: 0.55, currentVariant: "thumbnail" }),
        "thumbnail",
    );
});

test("always uses an original for a pinned visible image and skips offscreen images", () => {
    assert.equal(getCanvasImageVariant({ visible: true, width: 120, height: 120, scale: 0.1, pinned: true }), "original");
    assert.equal(getCanvasImageVariant({ visible: false, width: 4096, height: 4096, scale: 1, pinned: true }), "none");
});
