import type { CanvasNodeData, CanvasNodeMetadata } from "../types";
import { imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";

type ModelName = { id: string; name: string };
export type GeneratedResultDetails = { prompt: string; model: string; parameters: { label: string; value: string }[] };

export function isGeneratedImageResult(node: CanvasNodeData): boolean {
    const meta = node.metadata;
    // Older upload replacements retained task IDs, so only an explicit generation
    // marker reliably distinguishes a result from an input image.
    return node.type === "image" && Boolean(meta?.mediaId || meta?.content) && meta?.status !== "loading" && meta?.status !== "error" && (meta?.generationType === "generation" || meta?.generationType === "edit");
}

export function clearGeneratedImageIdentity(metadata: CanvasNodeMetadata | undefined): CanvasNodeMetadata {
    const next = { ...metadata };
    delete next.generationType;
    delete next.imageProviderName;
    delete next.imageTaskId;
    delete next.imageTaskClientRequestId;
    return next;
}

export function generatedImageDetails(metadata: CanvasNodeMetadata | undefined, models: readonly ModelName[] = []): GeneratedResultDetails {
    const meta = metadata || {};
    const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
    // Read only recorded values. Schema defaults and current generation settings
    // cannot reconstruct what a historical request actually submitted.
    const option = (key: string, fallback: unknown) => text(meta.providerOptions?.[key]) || text(fallback);
    const display = (value: string | undefined, format: (value: string) => string = value => value) => value ? value === "auto" ? "自动" : format(value) : "未记录";
    return {
        prompt: meta.prompt || "",
        model: text(meta.imageProviderName) || models.find(model => model.id === meta.imageProviderId)?.name || text(meta.imageProviderId) || "未记录",
        parameters: [
            { label: "比例", value: display(option("size", meta.size), imageSizeLabel) },
            { label: "分辨率", value: display(option("resolution", meta.resolution), value => value.replace(/k$/i, "K")) },
            { label: "格式", value: display(option("outputFormat", meta.outputFormat), value => value.toUpperCase()) },
            { label: "质量", value: display(option("quality", meta.quality), imageQualityLabel) },
        ],
    };
}

export function isGeneratedVideoResult(node: CanvasNodeData): boolean {
    const meta = node.metadata;
    // A task ID alone is ambiguous: historical upload replacements retained it.
    return node.type === "video" && meta?.generationMode === "video" && Boolean(meta.mediaId || meta.content) && meta.status !== "loading" && meta.status !== "error";
}

export function generatedVideoDetails(metadata: CanvasNodeMetadata | undefined, models: readonly ModelName[] = []): GeneratedResultDetails {
    const meta = metadata || {};
    const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
    const display = (value: string | null | undefined, format: (value: string) => string = value => value) => {
        const recorded = text(value);
        return recorded ? recorded === "auto" ? "自动" : format(recorded) : "未记录";
    };
    return {
        prompt: meta.prompt || "",
        model: text(meta.videoProviderName) || models.find(model => model.id === meta.videoProviderId)?.name || text(meta.videoProviderId) || "未记录",
        parameters: [
            { label: "分辨率", value: display(meta.vquality, value => value.replace(/k$/i, "K")) },
            { label: "比例", value: display(meta.videoSize) },
            { label: "时长", value: display(meta.seconds, value => /^\d+(\.\d+)?$/.test(value) ? `${value} 秒` : value) },
        ],
    };
}
