import assert from "node:assert/strict";
import test from "node:test";

import { canUseServerMediaReferences } from "./image.ts";

test("uses server media IDs only when every ordered image has a stable media ID", () => {
    assert.equal(
        canUseServerMediaReferences([
            { id: "a", name: "a.png", type: "image/png", dataUrl: "", mediaId: "media-a" },
            { id: "b", name: "b.png", type: "image/png", dataUrl: "", mediaId: "media-b" },
        ]),
        true,
    );
    assert.equal(canUseServerMediaReferences([{ id: "legacy", name: "legacy.png", type: "image/png", dataUrl: "data:image/png;base64,abc" }]), false);
    assert.equal(canUseServerMediaReferences([]), false);
});
