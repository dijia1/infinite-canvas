import assert from "node:assert/strict";
import test from "node:test";

import { clipboardImageFile } from "./clipboard-image.ts";

test("returns the image file from clipboard items", () => {
    const image = new File(["image"], "pasted.png", { type: "image/png" });
    const result = clipboardImageFile([
        { type: "text/plain", getAsFile: () => null },
        { type: "image/png", getAsFile: () => image },
    ]);

    assert.equal(result, image);
});

test("ignores clipboard items that are not images", () => {
    assert.equal(clipboardImageFile([{ type: "text/plain", getAsFile: () => null }]), null);
});
