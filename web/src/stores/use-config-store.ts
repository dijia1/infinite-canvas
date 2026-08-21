"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { apiGet } from "@/services/api/request";
import { normalizeImageResolution } from "@/lib/image-generation-config";

export type AiConfig = {
    /** @deprecated 仅兼容旧画布记录，不再参与请求。 */
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    models: string[];
    systemPrompt: string;
    videoSeconds: string;
    vquality: string;
    quality: string;
    size: string;
    resolution: string;
    count: string;
};

export type AIStatus = { imageAvailable: boolean; imageEditable: boolean; videoAvailable: boolean };
export type AICapability = "image" | "imageEdit" | "video";

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";

export const defaultConfig: AiConfig = { model: "", imageModel: "", videoModel: "", textModel: "", models: [], systemPrompt: "", videoSeconds: "6", vquality: "720", quality: "auto", size: "1:1", resolution: "1k", count: "1" };

type ConfigStore = {
    config: AiConfig;
    status: AIStatus | null;
    isStatusLoading: boolean;
    isConfigOpen: boolean;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    loadPublicSettings: () => Promise<void>;
    isAiConfigReady: (capability: AICapability | AiConfig, legacyModel?: string) => boolean;
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
            updateConfig: (key, value) => set((state) => ({ config: { ...state.config, [key]: key === "resolution" ? normalizeImageResolution(value as string) : value } })),
            loadPublicSettings: async () => {
                if (get().isStatusLoading) return;
                set({ isStatusLoading: true });
                try {
                    set({ status: await apiGet<AIStatus>("/api/settings") });
                } catch {
                    set({ status: null });
                } finally {
                    set({ isStatusLoading: false });
                }
            },
            isAiConfigReady: (capability) => {
                if (typeof capability !== "string") return Boolean(get().status?.imageAvailable || get().status?.videoAvailable);
                return capability === "imageEdit" ? Boolean(get().status?.imageEditable) : Boolean(get().status?.[capability === "image" ? "imageAvailable" : "videoAvailable"]);
            },
            openConfigDialog: (shouldPromptContinue = false) => set({ isConfigOpen: true, shouldPromptContinue }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        { name: CONFIG_STORE_KEY, partialize: (state) => ({ config: state.config }) },
    ),
);

export function useEffectiveConfig() {
    return useConfigStore((state) => state.config);
}
