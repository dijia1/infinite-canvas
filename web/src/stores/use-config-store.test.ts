import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig, isCapabilityReady, normalizePersistedAiConfig } from "./use-config-store.ts";

test("normalizes legacy persisted AI config to current fields", () => {
    const normalized = normalizePersistedAiConfig({ model: "old", imageModel: "old-image", videoModel: "old-video", textModel: "old-text", models: ["old"], systemPrompt: "old prompt", size: "16:9", resolution: "1024x1024" });

    assert.deepEqual(normalized, { ...defaultConfig, size: "16:9", resolution: "1k" });
    for (const obsoleteField of ["model", "imageModel", "videoModel", "textModel", "models", "systemPrompt"]) {
        assert.equal(obsoleteField in normalized, false);
    }
});

test("reports readiness for the requested capability only", () => {
    assert.equal(isCapabilityReady({ imageAvailable: false, imageEditable: false, videoAvailable: true }, "image"), false);
    assert.equal(isCapabilityReady({ imageAvailable: true, imageEditable: false, videoAvailable: true }, "imageEdit"), false);
    assert.equal(isCapabilityReady({ imageAvailable: true, imageEditable: true, videoAvailable: false }, "imageEdit"), true);
});
