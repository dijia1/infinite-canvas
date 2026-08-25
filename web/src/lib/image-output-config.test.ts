import assert from "node:assert/strict";
import test from "node:test";

import { imageOutputSettings, normalizeImageOutputFormat } from "./image-output-config.ts";

test("image output defaults to opaque JPEG and PNG always selects transparent output", () => {
    assert.equal(normalizeImageOutputFormat(undefined), "jpeg");
    assert.equal(normalizeImageOutputFormat("jpeg"), "jpeg");
    assert.equal(normalizeImageOutputFormat("png"), "png");
    assert.equal(normalizeImageOutputFormat("auto"), "jpeg");
    assert.deepEqual(imageOutputSettings("jpeg"), { outputFormat: "jpeg", background: "opaque" });
    assert.deepEqual(imageOutputSettings("png"), { outputFormat: "png", background: "transparent" });
});
