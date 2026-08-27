import { normalizeImageResolution } from "./image-generation-config";

export type AiConfig = {
    videoSeconds: string;
    vquality: string;
    quality: string;
    size: string;
	resolution: string;
	outputFormat: string;
	background?: string;
	imageProviderId?: string;
	videoProviderId?: string;
	imageProviderType?: string;
	imageRequestSchemaVersion?: string;
	providerOptions?: Record<string, unknown>;
	count: string;
};

export const defaultAiConfig: AiConfig = {
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

export function normalizePersistedAiConfig(input: unknown): AiConfig {
    const persisted = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const stringValue = (key: keyof AiConfig, fallback: string) => (typeof persisted[key] === "string" ? persisted[key] : fallback);
    const resolution = stringValue("resolution", defaultAiConfig.resolution);
    const normalized: AiConfig = {
        videoSeconds: stringValue("videoSeconds", defaultAiConfig.videoSeconds),
        vquality: stringValue("vquality", defaultAiConfig.vquality),
        quality: stringValue("quality", defaultAiConfig.quality),
        size: stringValue("size", defaultAiConfig.size),
        resolution: /^\s*\d+x\d+\s*$/i.test(resolution) ? normalizeImageResolution(resolution) : resolution,
        outputFormat: stringValue("outputFormat", defaultAiConfig.outputFormat),
        background: stringValue("background", defaultAiConfig.background || "auto"),
        providerOptions:
            persisted.providerOptions && typeof persisted.providerOptions === "object" && !Array.isArray(persisted.providerOptions)
                ? { ...(persisted.providerOptions as Record<string, unknown>) }
                : {},
        count: stringValue("count", defaultAiConfig.count),
    };
    for (const key of ["imageProviderId", "videoProviderId", "imageProviderType", "imageRequestSchemaVersion"] as const) {
        if (typeof persisted[key] === "string") normalized[key] = persisted[key];
    }
    return normalized;
}
