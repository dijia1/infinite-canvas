"use client";
import { reconcileVideoConfig } from "@/lib/video-config";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { apiGet } from "@/services/api/request";
import { defaultAiConfig, normalizePersistedAiConfig, type AiConfig } from "@/lib/ai-config";
import { normalizeImageRequestOptions, type ImageRequestSchema } from "@/lib/image-request-schema";
import { resolveSelectedModel, type AIModelChoice } from "@/lib/model-selection";

export type { AiConfig } from "@/lib/ai-config";
export { normalizePersistedAiConfig } from "@/lib/ai-config";

export type AIStatus = {
    imageAvailable: boolean;
    imageEditable: boolean;
    videoAvailable: boolean;
    imageProviderType?: string;
    imageRequestSchema?: ImageRequestSchema;
    imageModels?: AIModelChoice[];
    videoModels?: AIModelChoice[];
    defaultImageModelId?: string;
    defaultVideoModelId?: string;
};
export type AICapability = "image" | "imageEdit" | "video";

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";

export const defaultConfig: AiConfig = defaultAiConfig;

type ConfigStore = {
    config: AiConfig;
    status: AIStatus | null;
    isStatusLoading: boolean;
    isConfigOpen: boolean;
    shouldPromptContinue: boolean;
    loadPublicSettings: () => Promise<void>;
    isAiConfigReady: (capability: AICapability) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            status: null,
            isStatusLoading: false,
            isConfigOpen: false,
            shouldPromptContinue: false,
            loadPublicSettings: async () => {
                if (get().isStatusLoading) return;
                set({ isStatusLoading: true });
                try {
                    const status = await apiGet<AIStatus>("/api/settings");
                    set((state) => ({
                        status,
                        config: reconcileProviderConfig(state.config, status),
                    }));
                } catch {
                    set({ status: null });
                } finally {
                    set({ isStatusLoading: false });
                }
            },
            isAiConfigReady: (capability) => isCapabilityReady(get().status, capability),
            openConfigDialog: (shouldPromptContinue = false) => set({ isConfigOpen: true, shouldPromptContinue }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: (state) => ({ config: normalizePersistedAiConfig(state.config) }),
            merge: (persistedState, currentState) => ({
                ...currentState,
                config: normalizePersistedAiConfig((persistedState as { config?: unknown } | undefined)?.config),
            }),
        },
    ),
);

export function isCapabilityReady(status: AIStatus | null | undefined, capability: AICapability): boolean {
    if (!status) return false;
    if (capability === "imageEdit") return status.imageEditable;
    return capability === "image" ? status.imageAvailable : status.videoAvailable;
}

export function reconcileProviderConfig(config: AiConfig, status: AIStatus | null, resetVideoResolution = false): AiConfig {
    if (!status) return config;
    const imageModel = resolveSelectedModel(status.imageModels, config.imageProviderId, status.defaultImageModelId);
    const schema = imageModel?.imageRequestSchema || status.imageRequestSchema;
    const providerType = imageModel?.type || status.imageProviderType;
    const baseConfig = reconcileVideoConfig({ ...config, imageProviderId: imageModel?.id || config.imageProviderId }, status, resetVideoResolution);
    if (!schema || !providerType) return baseConfig;
    const legacyOptions = { quality: config.quality, size: config.size, resolution: config.resolution, outputFormat: config.outputFormat, background: config.background };
    const options = normalizeImageRequestOptions(schema, config.imageProviderType === providerType ? { ...legacyOptions, ...config.providerOptions } : legacyOptions);
    return {
        ...baseConfig,
        imageProviderId: imageModel?.id,
        videoProviderId: baseConfig.videoProviderId,
        imageProviderType: providerType,
        imageRequestSchemaVersion: schema.version,
        providerOptions: options,
        quality: typeof options.quality === "string" ? options.quality : config.quality,
        size: typeof options.size === "string" ? options.size : config.size,
        resolution: typeof options.resolution === "string" ? options.resolution : config.resolution,
        outputFormat: typeof options.outputFormat === "string" ? options.outputFormat : config.outputFormat,
        background: typeof options.background === "string" ? options.background : config.background,
    };
}

export function useEffectiveConfig() {
    return useConfigStore((state) => state.config);
}
