import assert from "node:assert/strict";
import test from "node:test";

import { getCanvasImageVariant, getCanvasRenderDetail } from "./canvas-media-policy.ts";

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
        getCanvasImageVariant({ visible: true, width: 1024, height: 1024, scale: 0.22, currentVariant: "original" }),
        "original",
    );
    assert.equal(
        getCanvasImageVariant({ visible: true, width: 1024, height: 1024, scale: 0.22, currentVariant: "thumbnail" }),
        "thumbnail",
    );
});

test("always uses an original for a pinned image, including when its panel is open offscreen", () => {
    assert.equal(getCanvasImageVariant({ visible: true, width: 120, height: 120, scale: 0.1, pinned: true }), "original");
    assert.equal(getCanvasImageVariant({ visible: false, width: 4096, height: 4096, scale: 1, pinned: true }), "original");
});

test("uses compact overview rendering at low zoom and restores full node controls after zooming in", () => {
    assert.equal(getCanvasRenderDetail(0.07), "overview");
    assert.equal(getCanvasRenderDetail(0.3), "overview");
    assert.equal(getCanvasRenderDetail(0.31), "full");
});

test("loads the original for a medium image that occupies at least 256 screen pixels", () => {
    assert.equal(
        getCanvasImageVariant({ visible: true, width: 576, height: 576, scale: 0.53 }),
        "original",
    );
});

test("uses overview rendering through 30 percent zoom", () => {
    assert.equal(getCanvasRenderDetail(0.3), "overview");
    assert.equal(getCanvasRenderDetail(0.31), "full");
});
