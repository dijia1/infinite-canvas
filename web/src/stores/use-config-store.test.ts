import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig, isCapabilityReady, normalizePersistedAiConfig, reconcileProviderConfig } from "./use-config-store.ts";

test("keeps a persisted upstream resolution unchanged while removing obsolete fields", () => {
    const normalized = normalizePersistedAiConfig({ model: "old", imageModel: "old-image", videoModel: "old-video", textModel: "old-text", models: ["old"], systemPrompt: "old prompt", size: "16:9", resolution: "1024x1024" });

    assert.deepEqual(normalized, { ...defaultConfig, size: "16:9", resolution: "1024x1024" });
    for (const obsoleteField of ["model", "imageModel", "videoModel", "textModel", "models", "systemPrompt"]) {
        assert.equal(obsoleteField in normalized, false);
    }
});

test("reports readiness for the requested capability only", () => {
    assert.equal(isCapabilityReady({ imageAvailable: false, imageEditable: false, videoAvailable: true }, "image"), false);
    assert.equal(isCapabilityReady({ imageAvailable: true, imageEditable: false, videoAvailable: true }, "imageEdit"), false);
    assert.equal(isCapabilityReady({ imageAvailable: true, imageEditable: true, videoAvailable: false }, "imageEdit"), true);
});

test("model reconciliation keeps a removed ratio until the user explicitly changes it", () => {
    const next = reconcileProviderConfig(
        { ...defaultConfig, size: "1:1", imageProviderType: "image", providerOptions: { size: "1:1" } },
        {
            imageAvailable: true,
            imageEditable: true,
            videoAvailable: false,
            imageProviderType: "image",
            imageRequestSchema: { version: "v2", maxReferenceImages: 0, supportsMask: false, fields: [{ key: "size", label: "比例", type: "select", required: true, default: "7:3", options: [{ value: "7:3", label: "7:3" }] }] },
        },
    );
    assert.equal(next.size, "1:1");
    assert.equal(next.providerOptions?.size, "1:1");
});


test("switching to Seedream NSFW removes hidden quality and transparency settings", () => {
    const schema = {
        version: "v1", maxReferenceImages: 10, supportsMask: false,
        fields: [
            { key: "size", label: "宽高比", type: "select" as const, required: true, default: "1:1", options: [{ value: "1:1", label: "1:1" }] },
            { key: "resolution", label: "尺寸", type: "select" as const, required: true, default: "2K", options: [{ value: "2K", label: "2K" }] },
            { key: "outputFormat", label: "输出格式", type: "select" as const, required: false, default: "jpeg", options: [{ value: "jpeg", label: "JPEG" }, { value: "png", label: "PNG" }] },
        ],
    };
    const previous = { ...defaultConfig, imageProviderId: "nsfw", imageProviderType: "maizi-image", quality: "high", outputFormat: "png", background: "transparent", providerOptions: { quality: "high", background: "transparent", nsfw_check: true } };
    const status = { imageAvailable: true, imageEditable: true, videoAvailable: false, imageModels: [{ id: "nsfw", name: "Seedream NSFW", type: "maizi-seedream-5-pro-nsfw", imageRequestSchema: schema }] };
    const next = reconcileProviderConfig(previous, status);
    assert.equal(next.imageProviderId, "nsfw");
    assert.equal(next.quality, "auto");
    assert.equal(next.background, "opaque");
    assert.equal(next.outputFormat, "png");
    assert.deepEqual(next.providerOptions, { size: "1:1", resolution: "2K", outputFormat: "png" });
    assert.equal(previous.background, "transparent");
    const ordinary = reconcileProviderConfig(previous, { ...status, imageModels: [{ ...status.imageModels[0]!, type: "maizi-image", imageRequestSchema: { ...schema, fields: [...schema.fields, { key: "quality", label: "质量", type: "text" as const, required: false }, { key: "background", label: "背景", type: "text" as const, required: false }] } }] });
    assert.equal(ordinary.quality, "high");
    assert.equal(ordinary.background, "transparent");
});
