import { normalizeImageResolution } from "../../../../lib/image-generation-config.ts";
import { normalizeImageBackground, normalizeImageOutputFormat } from "../../../../lib/image-output-config.ts";
import type { AiConfig } from "../../../../lib/ai-config";
import type { ReferenceImage } from "../../../../types/image";
import { normalizeImageMask } from "../image-mask/mask-utils";
import { CanvasNodeType, type CanvasConnection, type CanvasImageGenerationType, type CanvasNodeData, type CanvasNodeMetadata } from "../types.ts";

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
    const persistedReferences = references
        .map((reference) => ({ url: referenceUrl(reference), mask: normalizeImageMask(reference.mask) }))
        .filter((reference): reference is { url: string; mask: ReturnType<typeof normalizeImageMask> } => Boolean(reference.url));
    return {
        generationType: type,
        size: config.size,
        resolution: generationResolution(config),
        outputFormat: normalizeImageOutputFormat(config.outputFormat),
		background: normalizeImageBackground(config.background),
        quality: config.quality,
		...(config.imageProviderType ? { imageProviderId: config.imageProviderId, imageProviderType: config.imageProviderType, imageRequestSchemaVersion: config.imageRequestSchemaVersion, providerOptions: config.providerOptions } : {}),
		...(config.videoProviderId ? { videoProviderId: config.videoProviderId } : {}),
        count,
        references: persistedReferences.map((reference) => reference.url),
        ...(persistedReferences.some((reference) => Boolean(reference.mask)) ? { referenceMasks: persistedReferences.map((reference) => reference.mask) } : {}),
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

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, fallbackConfig: AiConfig): AiConfig {
	const imageProviderId = node?.metadata?.imageProviderId || config.imageProviderId;
	const useNodeProviderOptions = Boolean(node?.metadata?.imageProviderId && node.metadata.imageProviderId === imageProviderId);
	const imageProviderType = useNodeProviderOptions ? node?.metadata?.imageProviderType || config.imageProviderType : config.imageProviderType;
	const useNodeResolution = useNodeProviderOptions || !imageProviderType;
    return {
        ...config,
        model: node?.metadata?.model || config.model || fallbackConfig.model,
        quality: node?.metadata?.quality || config.quality || fallbackConfig.quality,
        size: node?.metadata?.size || config.size || fallbackConfig.size,
		resolution: generationResolution({ ...config, resolution: useNodeResolution ? node?.metadata?.resolution || config.resolution || fallbackConfig.resolution : config.resolution || fallbackConfig.resolution, imageProviderType }),
        outputFormat: normalizeImageOutputFormat(node?.metadata?.outputFormat || config.outputFormat || fallbackConfig.outputFormat),
		background: normalizeImageBackground(node?.metadata?.background || config.background || fallbackConfig.background),
		...(imageProviderType
			? {
					imageProviderType,
					imageProviderId,
					imageRequestSchemaVersion: useNodeProviderOptions ? node?.metadata?.imageRequestSchemaVersion || config.imageRequestSchemaVersion : config.imageRequestSchemaVersion,
					providerOptions: useNodeProviderOptions ? node?.metadata?.providerOptions || config.providerOptions : config.providerOptions,
				}
			: {}),
		...(node?.metadata?.videoProviderId || config.videoProviderId ? { videoProviderId: node?.metadata?.videoProviderId || config.videoProviderId } : {}),
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || fallbackConfig.videoSeconds,
        vquality: node?.metadata?.vquality || config.vquality || fallbackConfig.vquality,
        count: String(node?.metadata?.count || config.count || fallbackConfig.count),
    };
}

// Config nodes own their selected provider. This migrates nodes created before
// provider selection existed, so a later global preference change cannot alter
// an existing workflow.
export function snapshotConfigNodeProviderSelection(nodes: CanvasNodeData[], config: AiConfig): CanvasNodeData[] {
	let changed = false;
	const next = nodes.map((node) => {
		if (node.type !== CanvasNodeType.Config) return node;
		const metadata = node.metadata || {};
		const needsImageSnapshot = !metadata.imageProviderId && Boolean(config.imageProviderId);
		const needsVideoSnapshot = !metadata.videoProviderId && Boolean(config.videoProviderId);
		if (!needsImageSnapshot && !needsVideoSnapshot) return node;
		changed = true;
		return {
			...node,
			metadata: {
				...metadata,
				...(needsImageSnapshot
					? {
							imageProviderId: config.imageProviderId,
							imageProviderType: config.imageProviderType,
							imageRequestSchemaVersion: config.imageRequestSchemaVersion,
							providerOptions: { ...config.providerOptions },
						}
					: {}),
				...(needsVideoSnapshot ? { videoProviderId: config.videoProviderId } : {}),
			},
		};
	});
	return changed ? next : nodes;
}

function generationResolution(config: Pick<AiConfig, "resolution" | "imageProviderType">): string {
	return config.imageProviderType ? config.resolution || "1k" : normalizeImageResolution(config.resolution);
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
    const mask = normalizeImageMask(node.metadata.imageMask);
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content,
            storageKey: node.metadata.storageKey,
            ...(node.metadata.naturalWidth && node.metadata.naturalHeight ? { width: node.metadata.naturalWidth, height: node.metadata.naturalHeight } : {}),
            ...(mask ? { mask } : {}),
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
