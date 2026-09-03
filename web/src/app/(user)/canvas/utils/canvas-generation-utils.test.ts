import assert from "node:assert/strict";
import test from "node:test";

import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types.ts";
import { buildAngleLabel, buildAnglePrompt, buildGenerationConfig, buildImageGenerationMetadata, findRetrySourceNode, getGenerationCount, getInputSummary, replaceNodeWithUploadedVideo, resetInterruptedGeneration, snapshotConfigNodeProviderSelection, sourceNodeReferenceImages } from "./canvas-generation-utils.ts";

const config: AiConfig = {
    videoSeconds: "6",
    vquality: "720",
    quality: "auto",
    size: "1:1",
    resolution: "1k",
    outputFormat: "jpeg",
    background: "auto",
    providerOptions: {},
    count: "1",
};

const fallbackConfig: AiConfig = {
    ...config,
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
        outputFormat: "jpeg",
		background: "auto",
        quality: "high",
        count: 2,
        references: ["media:reference", "https://example.test/reference.png"],
    });
    assert.equal("model" in buildImageGenerationMetadata("edit", config, 1, []), false);
});

test("persists masks in the same order as reusable reference URLs", () => {
    const inlineReference: ReferenceImage = { id: "inline", name: "inline.png", type: "image/png", dataUrl: "data:image/png;base64,inline" };
    const maskedReference: ReferenceImage = {
        id: "masked",
        name: "masked.png",
        type: "image/png",
        dataUrl: "data:image/png;base64,masked",
        storageKey: "media:masked",
        mask: { version: 1, strokes: [{ id: "stroke", tool: "paint", radius: 0.1, points: [{ x: 0.5, y: 0.5 }] }] },
    };

    assert.deepEqual(buildImageGenerationMetadata("edit", config, 1, [inlineReference, maskedReference]), {
        generationType: "edit",
        size: "1:1",
        resolution: "1k",
        outputFormat: "jpeg",
		background: "auto",
        quality: "auto",
        count: 1,
        references: ["media:masked"],
        referenceMasks: [maskedReference.mask],
    });
});

test("normalizes node config without copying historical model fields", () => {
    const historicalConfig = JSON.parse(JSON.stringify({ ...config, model: "legacy-model", imageModel: "legacy-image-model", videoModel: "legacy-video-model", textModel: "legacy-text-model", models: ["legacy-model"], systemPrompt: "legacy prompt" })) as AiConfig;
    const configuredNode = JSON.parse(
        '{"id":"configured","type":"config","title":"configured","position":{"x":0,"y":0},"width":100,"height":100,"metadata":{"model":"node-model","quality":"node-quality","size":"4:3","resolution":"2048x1024","seconds":"12","vquality":"4k","count":3}}',
    ) as CanvasNodeData;
    const configuredResult = buildGenerationConfig({ ...historicalConfig, quality: "", size: "", resolution: "", outputFormat: "", videoSeconds: "", vquality: "", count: "" }, configuredNode, fallbackConfig);
    assert.deepEqual(
        {
            quality: configuredResult.quality,
            size: configuredResult.size,
            resolution: configuredResult.resolution,
            videoSeconds: configuredResult.videoSeconds,
            vquality: configuredResult.vquality,
            count: configuredResult.count,
        },
        {
            quality: "node-quality",
            size: "4:3",
            resolution: "2k",
            videoSeconds: "12",
            vquality: "4k",
            count: "3",
        },
    );
    for (const obsoleteField of ["model", "imageModel", "videoModel", "textModel", "models", "systemPrompt"]) {
        assert.equal(obsoleteField in configuredResult, false);
    }
});

test("replacing historical metadata with an uploaded video removes its obsolete model", () => {
    const historicalNode = JSON.parse(
        '{"id":"source","type":"image","title":"source","position":{"x":10,"y":20},"width":340,"height":240,"metadata":{"model":"historical-model","assetId":"asset-to-keep","errorDetails":"old error"}}',
    ) as CanvasNodeData;

    const result = replaceNodeWithUploadedVideo(
        historicalNode,
        "replacement.mp4",
        { content: "blob:video", storageKey: "video:1", status: "success", bytes: 12, mimeType: "video/mp4", naturalWidth: 1280, naturalHeight: 720 },
        { width: 420, height: 236 },
    );

    assert.equal(result.type, CanvasNodeType.Video);
    assert.equal("model" in (result.metadata || {}), false);
    assert.equal(result.metadata?.assetId, "asset-to-keep");
    assert.equal(result.metadata?.content, "blob:video");
    assert.equal(result.metadata?.errorDetails, undefined);
});

test("keeps a selected video provider when building a video task config", () => {
	const selected = buildGenerationConfig({ ...config, videoProviderId: "video-provider" }, undefined, fallbackConfig);
	assert.equal(selected.videoProviderId, "video-provider");
});

test("snapshots an old config node's selected providers before global defaults change", () => {
	const oldConfigNode = node("config", CanvasNodeType.Config, { quality: "high" });
	const initialConfig = {
		...config,
		imageProviderId: "maizi",
		imageProviderType: "maizi-image",
		imageRequestSchemaVersion: "v1",
		providerOptions: { size: "1:1", resolution: "1k" },
		videoProviderId: "doubao-video",
	};
	const snapshot = snapshotConfigNodeProviderSelection([oldConfigNode], initialConfig);
	assert.deepEqual(snapshot[0]?.metadata, {
		quality: "high",
		imageProviderId: "maizi",
		imageProviderType: "maizi-image",
		imageRequestSchemaVersion: "v1",
		providerOptions: { size: "1:1", resolution: "1k" },
		videoProviderId: "doubao-video",
	});

	const afterGlobalChange = snapshotConfigNodeProviderSelection(snapshot, { ...initialConfig, imageProviderId: "seedream", imageProviderType: "doubao-seedream-5-pro" });
	assert.equal(afterGlobalChange[0]?.metadata?.imageProviderId, "maizi");
	assert.equal(afterGlobalChange[0]?.metadata?.imageProviderType, "maizi-image");
});

test("keeps node-local provider options after global provider settings change", () => {
    const providerSnapshot = node("config", CanvasNodeType.Config, {
        quality: "high",
        size: "3:2",
        resolution: "1.5k",
        outputFormat: "png",
        background: "transparent",
        seconds: "8",
        vquality: "1080",
        count: 2,
        imageProviderId: "snapshot-provider",
        imageProviderType: "snapshot-type",
        imageRequestSchemaVersion: "snapshot-v1",
        providerOptions: { watermark: false, steps: 28 },
    });
    const changedGlobalConfig = {
        ...config,
        imageProviderId: "new-provider",
        imageProviderType: "new-type",
        imageRequestSchemaVersion: "new-v2",
        providerOptions: { watermark: true, steps: 8 },
        resolution: "2k",
    };

    const resolved = buildGenerationConfig(changedGlobalConfig, providerSnapshot, fallbackConfig);

    assert.equal(resolved.imageProviderId, "snapshot-provider");
    assert.equal(resolved.imageProviderType, "snapshot-type");
    assert.equal(resolved.imageRequestSchemaVersion, "snapshot-v1");
    assert.deepEqual(resolved.providerOptions, { watermark: false, steps: 28 });
    assert.equal(resolved.resolution, "1.5k");
});

test("uses the current provider resolution for legacy nodes without a provider snapshot", () => {
    const legacyNode = node("legacy", CanvasNodeType.Config, { resolution: "2048x1024" });
    const changedGlobalConfig = {
        ...config,
        imageProviderId: "new-provider",
        imageProviderType: "new-type",
        imageRequestSchemaVersion: "new-v2",
        providerOptions: { resolution: "1.5k" },
        resolution: "1.5k",
    };

    const resolved = buildGenerationConfig(changedGlobalConfig, legacyNode, fallbackConfig);

    assert.equal(resolved.resolution, "1.5k");
});

test("normalizes the stored resolution for legacy generic nodes", () => {
    const legacyNode = node("legacy", CanvasNodeType.Config, { resolution: "2048x1024" });

    const resolved = buildGenerationConfig(config, legacyNode, fallbackConfig);

    assert.equal(resolved.resolution, "2k");
});

test("preserves provider-specific resolutions and request options", () => {
	const seedream = buildGenerationConfig({ ...config, imageProviderType: "doubao-seedream-5-pro", imageRequestSchemaVersion: "v1", resolution: "1.5k", providerOptions: { resolution: "1.5k", watermark: false } }, undefined, fallbackConfig);
	assert.equal(seedream.resolution, "1.5k");
	assert.deepEqual(seedream.providerOptions, { resolution: "1.5k", watermark: false });
	assert.deepEqual(buildImageGenerationMetadata("generation", seedream, 1, []).providerOptions, { resolution: "1.5k", watermark: false });
});

test("falls back to supplied defaults when generation config is empty", () => {
    const emptyConfig: AiConfig = { ...config, quality: "", size: "", resolution: "", outputFormat: "", videoSeconds: "", vquality: "", count: "" };

    assert.deepEqual(buildGenerationConfig(emptyConfig, undefined, fallbackConfig), {
        ...emptyConfig,
        quality: "standard",
        size: "16:9",
        resolution: "2k",
        outputFormat: "jpeg",
        background: "auto",
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

test("creates a reference image from inline content or a persistent media ID", () => {
    const image = node("image-id", CanvasNodeType.Image, { content: "data:image/png;base64,content", storageKey: "image:stored", mimeType: "image/webp" });
    image.title = "Source image";

    assert.deepEqual(sourceNodeReferenceImages(image), [{ id: "image-id", name: "Source image.png", type: "image/webp", dataUrl: "data:image/png;base64,content", storageKey: "image:stored" }]);
    assert.deepEqual(sourceNodeReferenceImages(node("text", CanvasNodeType.Text, { content: "text" })), []);
    assert.deepEqual(sourceNodeReferenceImages(node("empty", CanvasNodeType.Image)), []);
    assert.deepEqual(sourceNodeReferenceImages(null), []);

    const persisted = node("persisted", CanvasNodeType.Image, { mediaId: "media-1", storageKey: "media:media-1:v1:original", mimeType: "image/png" });
    assert.deepEqual(sourceNodeReferenceImages(persisted), [{ id: "persisted", name: "persisted.png", type: "image/png", dataUrl: "", storageKey: "media:media-1:v1:original", mediaId: "media-1" }]);
});

test("carries an image node's hand-drawn mask into image editing", () => {
    const mask = { version: 1 as const, strokes: [{ id: "paint", tool: "paint" as const, radius: 0.05, points: [{ x: 0.2, y: 0.3 }] }] };
    const image = node("image-id", CanvasNodeType.Image, { content: "data:image/png;base64,content", imageMask: mask });

    assert.deepEqual(sourceNodeReferenceImages(image)[0]?.mask, mask);
});

test("formats positive and negative angle labels and includes them in prompts", () => {
    const positive = { horizontalAngle: 30, pitchAngle: 15, cameraDistance: 4.8, wideAngle: true };
    const negative = { horizontalAngle: -30, pitchAngle: -15, cameraDistance: 4.8, wideAngle: false };

    assert.equal(buildAngleLabel(positive), "AI 多角度：向右旋转 30 度，俯视 15 度，镜头距离 4.8，广角镜头");
    assert.equal(buildAngleLabel(negative), "AI 多角度：向左旋转 30 度，仰视 15 度，镜头距离 4.8，标准镜头");
    assert.match(buildAnglePrompt(positive), /AI 多角度：向右旋转 30 度，俯视 15 度，镜头距离 4.8，广角镜头/);
});
