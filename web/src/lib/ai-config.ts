export type AiConfig = {
    videoMode?: "draft" | "final";
    sourceDraftTaskId?: string;
    videoSeconds: string;
    videoSize?: string;
    generateAudio?: string;
    vquality: string | null;
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
    videoSeconds: "5",
    videoSize: "",
    generateAudio: "false",
    vquality: null,
    quality: "auto",
    size: "1:1",
    resolution: "",
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
        ...(persisted.videoMode === "draft" ? { videoMode: "draft" as const } : {}),
        videoSize: stringValue("videoSize", ""),
        generateAudio: stringValue("generateAudio", "false"),
        videoSeconds: stringValue("videoSeconds", defaultAiConfig.videoSeconds),
        vquality: typeof persisted.vquality === "string" ? persisted.vquality : null,
        quality: stringValue("quality", defaultAiConfig.quality),
        size: stringValue("size", defaultAiConfig.size),
        resolution,
        outputFormat: stringValue("outputFormat", defaultAiConfig.outputFormat),
        background: stringValue("background", defaultAiConfig.background || "auto"),
        providerOptions: persisted.providerOptions && typeof persisted.providerOptions === "object" && !Array.isArray(persisted.providerOptions) ? { ...(persisted.providerOptions as Record<string, unknown>) } : {},
        count: stringValue("count", defaultAiConfig.count),
    };
    for (const key of ["imageProviderId", "videoProviderId", "imageProviderType", "imageRequestSchemaVersion"] as const) {
        if (typeof persisted[key] === "string") normalized[key] = persisted[key];
    }
    return normalized;
}
