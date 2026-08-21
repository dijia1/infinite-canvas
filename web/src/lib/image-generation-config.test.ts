import assert from "node:assert/strict";
import test from "node:test";

import { normalizeImageResolution } from "./image-generation-config.ts";

test("normalizes historical pixel resolutions to fixed image resolution presets", () => {
    assert.equal(normalizeImageResolution("1024x1024"), "1k");
    assert.equal(normalizeImageResolution("2048x1152"), "2k");
    assert.equal(normalizeImageResolution("3840x2160"), "4k");
});

test("keeps valid presets and defaults invalid resolutions to 1k", () => {
    assert.equal(normalizeImageResolution("2k"), "2k");
    assert.equal(normalizeImageResolution(""), "1k");
});
