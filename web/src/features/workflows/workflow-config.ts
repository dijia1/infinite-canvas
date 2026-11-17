import type { AiConfig } from "@/lib/ai-config";
import type { AIModelChoice } from "@/lib/model-selection";
import { videoReferenceTotalError } from "@/lib/video-config";
import type { WorkflowGenerationConfig, WorkflowNode, WorkflowNodeType } from "./types";

type WorkflowInputCounts = { image: number; video: number; text: number };

export function workflowModelInputError(type: Extract<WorkflowNodeType, "image_generation" | "video_generation">, counts: WorkflowInputCounts, model: AIModelChoice | undefined) {
    if (!model) return "";
    if (type === "image_generation") {
        if (counts.video) return "生图模型不支持视频输入";
        const limit = model.imageRequestSchema?.maxReferenceImages;
        if (typeof limit === "number" && counts.image > limit) return `当前模型最多支持 ${limit} 个图片输入，已连接 ${counts.image} 个`;
        return "";
    }
    const imageLimit = model.videoRequestSchema?.maxReferenceImages;
    if (typeof imageLimit === "number" && counts.image > imageLimit) return `当前模型最多支持 ${imageLimit} 个图片输入，已连接 ${counts.image} 个`;
    const videoLimit = model.videoRequestSchema?.maxReferenceVideos;
    if (typeof videoLimit === "number" && counts.video > videoLimit) return `当前模型最多支持 ${videoLimit} 个视频输入，已连接 ${counts.video} 个`;
    return videoReferenceTotalError(model.videoRequestSchema, counts.image, counts.video);
}

export function aiConfigForWorkflowNode(node: WorkflowNode, fallback: AiConfig): AiConfig {
    const config = node.config || {};
    const common = {
        ...fallback,
        quality: config.quality || fallback.quality,
        size: config.size || fallback.size,
        resolution: config.resolution || fallback.resolution,
        outputFormat: config.outputFormat || fallback.outputFormat,
        background: config.background || fallback.background,
        providerOptions: { ...(config.options || {}) },
        count: String(Math.max(1, node.outputs?.length || 1)),
    };
    if (node.type === "video_generation") {
        return {
            ...common,
            videoMode: config.videoMode,
            videoProviderId: config.providerId,
            videoSize: config.size || fallback.videoSize,
            vquality: config.resolution || fallback.vquality,
            videoSeconds: String(config.seconds || Number(fallback.videoSeconds) || 5),
            generateAudio: String(config.generateAudio ?? fallback.generateAudio === "true"),
        };
    }
    return { ...common, imageProviderId: config.providerId };
}

export function workflowConfigFromAiConfig(type: Extract<WorkflowNodeType, "image_generation" | "video_generation">, config: AiConfig): WorkflowGenerationConfig {
    if (type === "video_generation") {
        return {
            ...(config.videoMode ? { videoMode: config.videoMode } : {}),
            ...(config.videoProviderId ? { providerId: config.videoProviderId } : {}),
            ...(config.videoSize ? { size: config.videoSize } : {}),
            ...(config.vquality ? { resolution: config.vquality } : {}),
            seconds: Math.max(1, Math.floor(Number(config.videoSeconds) || 5)),
            generateAudio: config.generateAudio === "true",
            ...(config.providerOptions && Object.keys(config.providerOptions).length ? { options: { ...config.providerOptions } } : {}),
        };
    }
    return {
        ...(config.imageProviderId ? { providerId: config.imageProviderId } : {}),
        ...(config.size ? { size: config.size } : {}),
        ...(config.resolution ? { resolution: config.resolution } : {}),
        ...(config.quality ? { quality: config.quality } : {}),
        ...(config.outputFormat ? { outputFormat: config.outputFormat } : {}),
        ...(config.background ? { background: config.background } : {}),
        ...(config.providerOptions && Object.keys(config.providerOptions).length ? { options: { ...config.providerOptions } } : {}),
    };
}
