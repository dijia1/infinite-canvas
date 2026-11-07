import assert from "node:assert/strict";
import test from "node:test";
import { imageBackgroundLabel, imageOutputFormatLabel, imageQualityLabel, imageResolutionLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { defaultAiConfig } from "@/lib/ai-config";
import { normalizeImageRequestOptions, schemaOptionString, type ImageRequestSchema } from "@/lib/image-request-schema";
import { sourceBehavior } from "@/test-utils/source-behavior";

const summary = sourceBehavior(new URL("./canvas-image-settings-popover.tsx", import.meta.url), {
    imageBackgroundLabel, imageOutputFormatLabel, imageQualityLabel, imageResolutionLabel, imageSizeLabel, schemaOptionString,
}).named("imageSettingsSummary");
const config = { ...defaultAiConfig, quality: "auto", size: "1:1", resolution: "1K", outputFormat: "jpeg", background: "opaque", count: "3" };

test("compact image settings show size and output format instead of quality and count", () => {
    assert.equal(summary(config, undefined, {}, "auto", "1:1", 3, true), "1K · JPEG");
    assert.equal(summary({ ...config, resolution: "2K", outputFormat: "png" }, undefined, {}, "high", "16:9", 1, true), "2K · PNG");
});

test("compact summary follows normalized model options over stale common fields", () => {
    const schema: ImageRequestSchema = { version: "v1", maxReferenceImages: 9, supportsMask: false, fields: [
        { key: "resolution", label: "尺寸", type: "select", required: true, default: "2K", options: [{ value: "1K", label: "1K" }, { value: "2K", label: "2K" }] },
        { key: "outputFormat", label: "输出格式", type: "select", required: true, default: "png", options: [{ value: "jpeg", label: "JPEG" }, { value: "png", label: "PNG" }] },
    ] };
    assert.equal(summary(config, schema, normalizeImageRequestOptions(schema, {}), "auto", "1:1", 3, true), "2K · PNG");
    assert.equal(summary(config, schema, normalizeImageRequestOptions(schema, { resolution: "1K", outputFormat: "jpeg" }), "auto", "1:1", 3, true), "1K · JPEG");
});

test("full image settings retain quality, ratio, size, format, background and count", () => {
    assert.equal(summary(config, undefined, {}, "auto", "1:1", 3), "自动 · 1:1 · 1K · JPEG · 不透明 · 3 张");
});
