import assert from "node:assert/strict";
import test from "node:test";

import { isCapabilityReady } from "./use-config-store.ts";

test("reports readiness for the requested capability only", () => {
    assert.equal(isCapabilityReady({ imageAvailable: false, imageEditable: false, videoAvailable: true }, "image"), false);
    assert.equal(isCapabilityReady({ imageAvailable: true, imageEditable: false, videoAvailable: true }, "imageEdit"), false);
    assert.equal(isCapabilityReady({ imageAvailable: true, imageEditable: true, videoAvailable: false }, "imageEdit"), true);
});
