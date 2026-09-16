import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MASK_COLOR, MASK_PREVIEW_OPACITY, normalizeMaskPreviewColor } from "./use-mask-preferences-store";

test("invalid persisted colors fall back to the existing red preview", () => {
    for (const value of [undefined, null, "", "rgba(0,0,0,0)", "invalid", {}, 123]) assert.equal(normalizeMaskPreviewColor(value), DEFAULT_MASK_COLOR);
    assert.equal(normalizeMaskPreviewColor("#1A80FF"), "#1a80ff");
    assert.equal(MASK_PREVIEW_OPACITY, 0.3);
});
