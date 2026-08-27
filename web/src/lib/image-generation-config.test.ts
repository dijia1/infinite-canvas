import assert from "node:assert/strict";
import test from "node:test";

import { imageAspectOptions, normalizeImageResolution } from "./image-generation-config.ts";

test("normalizes historical pixel resolutions to fixed image resolution presets", () => {
    assert.equal(normalizeImageResolution("1024x1024"), "1k");
    assert.equal(normalizeImageResolution("2048x1152"), "2k");
    assert.equal(normalizeImageResolution("3840x2160"), "4k");
});

test("keeps valid presets and defaults invalid resolutions to 1k", () => {
    assert.equal(normalizeImageResolution("2k"), "2k");
    assert.equal(normalizeImageResolution(""), "1k");
});

test("offers widescreen 16:9 and ultrawide 21:9 aspect ratios", () => {
    assert.deepEqual(
        imageAspectOptions.filter((item) => item.value === "16:9" || item.value === "21:9").map((item) => item.value),
        ["16:9", "21:9"],
    );
});
