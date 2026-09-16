import type { AiConfig } from "./ai-config";
import { resolveSelectedModel, type AIModelChoice, type VideoRequestSchema } from "./model-selection";

export type VideoModelStatus = { videoModels?: AIModelChoice[]; defaultVideoModelId?: string };

export function videoDurationOptions(schema: VideoRequestSchema | undefined) {
    const minDuration = schema?.minDuration ?? 4;
    const maxDuration = schema?.maxDuration ?? 15;
    return Array.from({ length: Math.max(0, maxDuration - minDuration + 1) }, (_, index) => {
        const value = String(minDuration + index);
        return { value, label: `${value} 秒` };
    });
}

export function videoSupportsAudio(schema: VideoRequestSchema | undefined) {
    return schema?.supportsAudio !== false;
}

export function reconcileVideoConfig(config: AiConfig, status: VideoModelStatus | null | undefined, reset = false): AiConfig {
    // Unknown/loading settings must not erase a saved selection.
    if (!status) return config;
    const model = resolveSelectedModel(status.videoModels, config.videoProviderId, status.defaultVideoModelId);
    const schema = model?.videoRequestSchema;
    const options = schema?.resolutions || [];
    const aspectRatios = schema?.aspectRatios || [];
    const changedModel = Boolean(model && config.videoProviderId && model.id !== config.videoProviderId);
    const vquality = !reset && !changedModel && options.some((option) => option.value === config.vquality) ? config.vquality : (options[0]?.value ?? null);
    const videoSize = !reset && !changedModel && aspectRatios.includes(config.videoSize || "") ? config.videoSize : aspectRatios[0] || "";
    const seconds = Number(config.videoSeconds);
    const validSeconds = Number.isInteger(seconds) && Boolean(schema) && seconds >= schema!.minDuration && seconds <= schema!.maxDuration;
    const videoSeconds = !reset && !changedModel && validSeconds ? config.videoSeconds : String(schema?.defaultDuration || 5);
    const generateAudio = schema?.supportsAudio === false ? "false" : config.generateAudio;
    const videoProviderId = model?.id || config.videoProviderId;
    return vquality === config.vquality && videoProviderId === config.videoProviderId && videoSize === (config.videoSize || "") && videoSeconds === config.videoSeconds && generateAudio === config.generateAudio
        ? config
        : { ...config, videoProviderId, vquality, videoSize, videoSeconds, generateAudio };
}
