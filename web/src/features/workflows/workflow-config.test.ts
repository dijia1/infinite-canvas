import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import type { ImageRequestSchema } from "@/lib/image-request-schema";
import { reconcileProviderConfig } from "@/stores/use-config-store";
import { sourceBehavior } from "@/test-utils/source-behavior";
import { elements } from "@/test-utils/source-component";

import { defaultAiConfig } from "@/lib/ai-config";
import { aiConfigForWorkflowNode, workflowConfigFromAiConfig, workflowModelInputError } from "./workflow-config";
import { createWorkflowNode } from "./workflow-graph";

test("maps saved image workflow settings to the shared settings panel without URLs", () => {
    const node = createWorkflowNode("image_generation", { x: 0, y: 0 }, "image");
    node.outputs = [...node.outputs!, { ...node.outputs![0]!, id: "second" }];
    node.config = { providerId: "provider-a", size: "16:9", resolution: "2k", quality: "high", outputFormat: "png", background: "transparent", options: { style: "photo" } };
    const config = aiConfigForWorkflowNode(node, defaultAiConfig);
    assert.equal(config.imageProviderId, "provider-a");
    assert.equal(config.count, "2");
    assert.deepEqual(config.providerOptions, { style: "photo" });
    assert.equal((config as unknown as Record<string, unknown>).url, undefined);
});

test("maps shared video settings back to the workflow JSON contract", () => {
    const config = { ...defaultAiConfig, videoProviderId: "video-a", videoSize: "16:9", vquality: "1080p", videoSeconds: "8", generateAudio: "true", providerOptions: { camera: "fixed" } };
    assert.deepEqual(workflowConfigFromAiConfig("video_generation", config), {
        providerId: "video-a",
        size: "16:9",
        resolution: "1080p",
        seconds: 8,
        generateAudio: true,
        options: { camera: "fixed" },
    });
});

test("rejects switching to a model below the already connected reference counts", () => {
    const model = { id: "limited", name: "Limited", type: "image", imageRequestSchema: { version: "v1", fields: [], maxReferenceImages: 1, supportsMask: false } };
    assert.match(workflowModelInputError("image_generation", { image: 2, video: 0, text: 1 }, model), /最多支持 1 个图片输入/);
    assert.equal(workflowModelInputError("image_generation", { image: 1, video: 0, text: 8 }, model), "");
});


test("schema-backed workflow settings update options and common fields once", () => {
    const schema: ImageRequestSchema = { version: "v1", maxReferenceImages: 10, supportsMask: false, fields: [
        { key: "size", label: "Ratio", type: "select", required: true, default: "1:1", options: [{ value: "1:1", label: "1:1" }] },
        { key: "resolution", label: "Resolution", type: "select", required: true, default: "1K", options: [{ value: "1K", label: "1K" }, { value: "2K", label: "2K" }] },
        { key: "outputFormat", label: "Format", type: "select", required: false, default: "jpeg", options: [{ value: "jpeg", label: "JPEG" }, { value: "png", label: "PNG" }] },
    ] };
    const selected = { id: "nsfw", name: "NSFW", type: "maizi-seedream-5-pro-nsfw", imageRequestSchema: schema };
    const aiStatus = { imageAvailable: true, imageEditable: true, videoAvailable: false, imageModels: [selected] };
    const config = { ...defaultAiConfig, imageProviderId: "nsfw", resolution: "1K", background: "opaque", providerOptions: { size: "1:1", resolution: "1K", outputFormat: "jpeg" } };
    const changes: ReturnType<typeof workflowConfigFromAiConfig>[] = [];
    const outputCounts: number[] = [];
    const scope = { config, selected, aiStatus, reconcileProviderConfig, updateAiConfig: (next: typeof config) => changes.push(workflowConfigFromAiConfig("image_generation", next)), onOutputCountChange: (count: number) => outputCounts.push(count) };
    const panel = new URL("./workflow-config-panel.tsx", import.meta.url);
    const onConfigChange = sourceBehavior(panel, scope).select((node) => ts.isArrowFunction(node) && ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) && node.parent.parent.name.getText() === "onConfigChange" && node.getText().includes("onOutputCountChange"));
    const onProviderOptionsChange = sourceBehavior(panel, scope).select((node) => ts.isArrowFunction(node) && ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) && node.parent.parent.name.getText() === "onProviderOptionsChange");
    const tree = ImageSettingsPanel({ config, schema, theme: canvasThemes.dark, onConfigChange, onProviderOptionsChange });
    const selects = elements(tree, (node) => Boolean(node.props["aria-label"]));
    selects.find((node) => node.props["aria-label"] === "尺寸")!.props.onChange("2K");
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.resolution, "2K");
    assert.equal(changes[0]!.options!.resolution, "2K");
    changes.length = 0;
    selects.find((node) => node.props["aria-label"] === "输出格式")!.props.onChange("png");
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.outputFormat, "png");
    assert.equal(changes[0]!.options!.outputFormat, "png");
    onConfigChange("count", "3");
    assert.deepEqual(outputCounts, [3]);
});
