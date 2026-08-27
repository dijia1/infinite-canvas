import assert from "node:assert/strict";
import test from "node:test";

import { imageOutputSettings, normalizeImageBackground, normalizeImageOutputFormat } from "./image-output-config.ts";

test("image output defaults to JPEG with an automatic background and preserves valid background choices", () => {
    assert.equal(normalizeImageOutputFormat(undefined), "jpeg");
    assert.equal(normalizeImageOutputFormat("jpeg"), "jpeg");
    assert.equal(normalizeImageOutputFormat("png"), "png");
    assert.equal(normalizeImageOutputFormat("auto"), "jpeg");
    assert.equal(normalizeImageBackground(undefined), "auto");
    assert.equal(normalizeImageBackground("opaque"), "opaque");
    assert.equal(normalizeImageBackground("transparent"), "transparent");
    assert.deepEqual(imageOutputSettings("jpeg"), { outputFormat: "jpeg", background: "auto" });
    assert.deepEqual(imageOutputSettings("png", "opaque"), { outputFormat: "png", background: "opaque" });
    assert.deepEqual(imageOutputSettings("png", "transparent"), { outputFormat: "png", background: "transparent" });
});

test("transparent output switches an incompatible JPEG request to PNG", () => {
    assert.deepEqual(imageOutputSettings("jpeg", "transparent"), { outputFormat: "png", background: "transparent" });
});
