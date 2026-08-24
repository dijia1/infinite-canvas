import assert from "node:assert/strict";
import test from "node:test";

import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types.ts";
import { buildAngleLabel, buildAnglePrompt, buildGenerationConfig, buildImageGenerationMetadata, findRetrySourceNode, getGenerationCount, getInputSummary, resetInterruptedGeneration, sourceNodeReferenceImages } from "./canvas-generation-utils.ts";

const config: AiConfig = {
    model: "legacy-model",
    imageModel: "image-model",
    videoModel: "video-model",
    textModel: "text-model",
    models: ["image-model", "video-model", "text-model"],
    systemPrompt: "",
    videoSeconds: "6",
    vquality: "720",
    quality: "auto",
    size: "1:1",
    resolution: "1k",
    count: "1",
};

const fallbackConfig: AiConfig = {
    ...config,
    model: "fallback-model",
    imageModel: "fallback-image-model",
    videoModel: "fallback-video-model",
    textModel: "fallback-text-model",
    quality: "standard",
    size: "16:9",
    resolution: "2k",
    videoSeconds: "8",
    vquality: "1080",
    count: "4",
};

function node(id: string, type: CanvasNodeType, metadata?: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata };
}

test("clamps and truncates generation counts", () => {
    assert.equal(getGenerationCount("-20"), 15);
    assert.equal(getGenerationCount("0"), 1);
    assert.equal(getGenerationCount("3.9"), 3);
});

test("summarizes text and image generation inputs", () => {
    assert.deepEqual(
        getInputSummary([
            { nodeId: "text", type: "text", title: "Text", text: "Prompt" },
            { nodeId: "image", type: "image", title: "Image" },
            { nodeId: "video", type: "video", title: "Video" },
        ]),
        { textCount: 1, imageCount: 1 },
    );
});

test("builds edit metadata with persisted or remote references only", () => {
    const storedReference: ReferenceImage = { id: "stored", name: "stored.png", type: "image/png", dataUrl: "data:image/png;base64,stored", storageKey: "media:reference" };
    const remoteReference: ReferenceImage = { id: "remote", name: "remote.png", type: "image/png", dataUrl: "https://example.test/reference.png" };
    const inlineReference: ReferenceImage = { id: "inline", name: "inline.png", type: "image/png", dataUrl: "data:image/png;base64,inline" };

    assert.deepEqual(buildImageGenerationMetadata("edit", { ...config, size: "3:2", resolution: "4k", quality: "high" }, 2, [storedReference, remoteReference, inlineReference]), {
        generationType: "edit",
        size: "3:2",
        resolution: "4k",
        quality: "high",
        count: 2,
        references: ["media:reference", "https://example.test/reference.png"],
    });
});

test("selects each generation model and normalizes node config", () => {
    assert.equal(buildGenerationConfig(config, undefined, "image", fallbackConfig).model, "image-model");
    assert.equal(buildGenerationConfig(config, undefined, "video", fallbackConfig).model, "video-model");
    assert.equal(buildGenerationConfig(config, undefined, "text", fallbackConfig).model, "text-model");

    const configuredNode = node("configured", CanvasNodeType.Config, {
        model: "node-model",
        quality: "node-quality",
        size: "4:3",
        resolution: "2048x1024",
        seconds: "12",
        vquality: "4k",
        count: 3,
    });
    const configuredResult = buildGenerationConfig({ ...config, model: "", imageModel: "", quality: "", size: "", resolution: "", videoSeconds: "", vquality: "", count: "" }, configuredNode, "image", fallbackConfig);
    assert.deepEqual(
        {
            model: configuredResult.model,
            quality: configuredResult.quality,
            size: configuredResult.size,
            resolution: configuredResult.resolution,
            videoSeconds: configuredResult.videoSeconds,
            vquality: configuredResult.vquality,
            count: configuredResult.count,
        },
        {
            model: "node-model",
            quality: "node-quality",
            size: "4:3",
            resolution: "2k",
            videoSeconds: "12",
            vquality: "4k",
            count: "3",
        },
    );
});

test("falls back to supplied defaults when generation config is empty", () => {
    const emptyConfig: AiConfig = { ...config, model: "", imageModel: "", videoModel: "", textModel: "", quality: "", size: "", resolution: "", videoSeconds: "", vquality: "", count: "" };

    assert.deepEqual(buildGenerationConfig(emptyConfig, undefined, "image", fallbackConfig), {
        ...emptyConfig,
        model: "fallback-model",
        quality: "standard",
        size: "16:9",
        resolution: "2k",
        videoSeconds: "8",
        vquality: "1080",
        count: "4",
    });
});

test("marks interrupted loading nodes as errors without changing other nodes", () => {
    const loading = node("loading", CanvasNodeType.Image, { status: "loading", prompt: "draw" });
    const persistentTask = node("persistent", CanvasNodeType.Image, { status: "loading", imageTaskId: "task-1", imageTaskClientRequestId: "request-1" });
    const success = node("success", CanvasNodeType.Text, { status: "success", content: "kept" });
    const result = resetInterruptedGeneration([loading, persistentTask, success]);

    assert.deepEqual(result[0]?.metadata, { status: "error", prompt: "draw", errorDetails: "页面刷新后生成已中断，请重新生成。" });
    assert.equal(result[1], persistentTask);
    assert.equal(result[2], success);
});

test("finds the nearest upstream config node breadth-first across retry branches", () => {
    const firstBranch = node("first-branch", CanvasNodeType.Image);
    const secondBranch = node("second-branch", CanvasNodeType.Text);
    const fartherMiddle = node("farther-middle", CanvasNodeType.Text);
    const fartherConfig = node("farther-config", CanvasNodeType.Config);
    const nearestConfig = node("nearest-config", CanvasNodeType.Config);
    const failed = node("failed", CanvasNodeType.Image);
    const connections: CanvasConnection[] = [
        { id: "1", fromNodeId: firstBranch.id, toNodeId: failed.id },
        { id: "2", fromNodeId: secondBranch.id, toNodeId: failed.id },
        { id: "3", fromNodeId: fartherMiddle.id, toNodeId: firstBranch.id },
        { id: "4", fromNodeId: fartherConfig.id, toNodeId: fartherMiddle.id },
        { id: "5", fromNodeId: nearestConfig.id, toNodeId: secondBranch.id },
    ];

    assert.equal(findRetrySourceNode(failed.id, [firstBranch, secondBranch, fartherMiddle, fartherConfig, nearestConfig, failed], connections), nearestConfig);
});

test("ends retry traversal for cycles without a config node", () => {
    const first = node("first", CanvasNodeType.Image);
    const second = node("second", CanvasNodeType.Text);
    const failed = node("failed", CanvasNodeType.Image);
    const connections: CanvasConnection[] = [
        { id: "1", fromNodeId: first.id, toNodeId: second.id },
        { id: "2", fromNodeId: second.id, toNodeId: first.id },
        { id: "3", fromNodeId: first.id, toNodeId: failed.id },
    ];

    assert.equal(findRetrySourceNode(failed.id, [first, second, failed], connections), null);
});

test("creates a reference image only from image nodes with content", () => {
    const image = node("image-id", CanvasNodeType.Image, { content: "data:image/png;base64,content", storageKey: "image:stored", mimeType: "image/webp" });
    image.title = "Source image";

    assert.deepEqual(sourceNodeReferenceImages(image), [{ id: "image-id", name: "Source image.png", type: "image/webp", dataUrl: "data:image/png;base64,content", storageKey: "image:stored" }]);
    assert.deepEqual(sourceNodeReferenceImages(node("text", CanvasNodeType.Text, { content: "text" })), []);
    assert.deepEqual(sourceNodeReferenceImages(node("empty", CanvasNodeType.Image)), []);
    assert.deepEqual(sourceNodeReferenceImages(null), []);
});

test("formats positive and negative angle labels and includes them in prompts", () => {
    const positive = { horizontalAngle: 30, pitchAngle: 15, cameraDistance: 4.8, wideAngle: true };
    const negative = { horizontalAngle: -30, pitchAngle: -15, cameraDistance: 4.8, wideAngle: false };

    assert.equal(buildAngleLabel(positive), "AI 多角度：向右旋转 30 度，俯视 15 度，镜头距离 4.8，广角镜头");
    assert.equal(buildAngleLabel(negative), "AI 多角度：向左旋转 30 度，仰视 15 度，镜头距离 4.8，标准镜头");
    assert.match(buildAnglePrompt(positive), /AI 多角度：向右旋转 30 度，俯视 15 度，镜头距离 4.8，广角镜头/);
});
