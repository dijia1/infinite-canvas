import { normalizeImageResolution } from "../../../../lib/image-generation-config.ts";
import type { AiConfig } from "../../../../lib/ai-config";
import type { ReferenceImage } from "../../../../types/image";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasImageGenerationType, type CanvasNodeData, type CanvasNodeMetadata } from "../types.ts";

type NodeGenerationInput = {
    nodeId: string;
    type: "text" | "image" | "video";
    title: string;
    text?: string;
    image?: ReferenceImage;
};

export type CanvasAngleParameters = {
    horizontalAngle: number;
    pitchAngle: number;
    cameraDistance: number;
    wideAngle: boolean;
};

export function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[]): CanvasNodeMetadata {
    return {
        generationType: type,
        size: config.size,
        resolution: config.resolution,
        quality: config.quality,
        count,
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
    };
}

export function referenceUrl(image: ReferenceImage): string | undefined {
    return image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

export function getGenerationCount(count: string): number {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

export function getInputSummary(inputs: NodeGenerationInput[]): { textCount: number; imageCount: number } {
    return {
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: inputs.filter((input) => input.type === "image").length,
    };
}

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasGenerationMode, fallbackConfig: AiConfig): AiConfig {
    const defaultModel = mode === "image" ? config.imageModel : mode === "video" ? config.videoModel : config.textModel;
    return {
        ...config,
        model: node?.metadata?.model || defaultModel || config.model || fallbackConfig.model,
        quality: node?.metadata?.quality || config.quality || fallbackConfig.quality,
        size: node?.metadata?.size || config.size || fallbackConfig.size,
        resolution: normalizeImageResolution(node?.metadata?.resolution || config.resolution || fallbackConfig.resolution),
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || fallbackConfig.videoSeconds,
        vquality: node?.metadata?.vquality || config.vquality || fallbackConfig.vquality,
        count: String(node?.metadata?.count || config.count || fallbackConfig.count),
    };
}

export function resetInterruptedGeneration(nodes: CanvasNodeData[]): CanvasNodeData[] {
    return nodes.map((node) => {
        if (node.metadata?.status !== "loading") return node;
        if (node.metadata.imageTaskId || node.metadata.imageTaskClientRequestId) return node;
        return { ...node, metadata: { ...node.metadata, status: "error" as const, errorDetails: "页面刷新后生成已中断，请重新生成。" } };
    });
}

export function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData | null {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

export function sourceNodeReferenceImages(node: CanvasNodeData | null): ReferenceImage[] {
    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) return [];
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content,
            storageKey: node.metadata.storageKey,
        },
    ];
}

export function buildAngleLabel(params: CanvasAngleParameters): string {
    const horizontal = params.horizontalAngle === 0 ? "正面视角" : params.horizontalAngle > 0 ? `向右旋转 ${params.horizontalAngle} 度` : `向左旋转 ${Math.abs(params.horizontalAngle)} 度`;
    const pitch = params.pitchAngle === 0 ? "水平视角" : params.pitchAngle > 0 ? `俯视 ${params.pitchAngle} 度` : `仰视 ${Math.abs(params.pitchAngle)} 度`;
    return `AI 多角度：${horizontal}，${pitch}，镜头距离 ${params.cameraDistance.toFixed(1)}，${params.wideAngle ? "广角" : "标准"}镜头`;
}

export function buildAnglePrompt(params: CanvasAngleParameters): string {
    return `基于参考图重新生成同一主体的新视角，保持主体、颜色、材质和画面风格一致，不要只做透视变形。${buildAngleLabel(params)}。`;
}
