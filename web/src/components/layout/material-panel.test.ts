import assert from "node:assert/strict";
import test from "node:test";

import { toggleMaterialPanel } from "./material-panel.ts";

test("opens the requested material drawer and closes it when selected again", () => {
    assert.equal(toggleMaterialPanel(null, "my-assets"), "my-assets");
    assert.equal(toggleMaterialPanel("my-assets", "my-assets"), null);
});

test("switches directly between the private and public material drawers", () => {
    assert.equal(toggleMaterialPanel("my-assets", "public-assets"), "public-assets");
});
