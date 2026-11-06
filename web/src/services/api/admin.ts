import { apiGet, apiPost } from "@/services/api/request";
import type { ImageRequestSchema } from "@/lib/image-request-schema";
import type { ImageResolutionPrice } from "@/lib/image-pricing";
import type { VideoRequestSchema } from "@/lib/model-selection";

export type AdminUser = {
    id: string;
    username: string;
    role: "admin";
};

export async function fetchCurrentAdmin() {
    return apiGet<AdminUser>("/api/admin/me");
}

export type AdminAIProvider = {
    id: string;
    name: string;
    type: string;
    enabled: boolean;
    imagePrices: ImageResolutionPrice[];
    videoPrices?: ImageResolutionPrice[];
    aspectRatios?: string[];
    config: Record<string, unknown>;
};

export type AdminAIProviderType = {
    id: string;
    name: string;
    capabilities: Array<"image_generate" | "image_edit" | "video_generate">;
    configFields: Array<{ key: string; label: string; type: "text" | "password"; placeholder?: string; required: boolean }>;
    imageRequestSchema?: ImageRequestSchema;
    videoRequestSchema?: VideoRequestSchema;
};

export type AdminAISettings = {
    providers: AdminAIProvider[];
    imageProviderId: string;
    videoProviderId: string;
};

export type AdminSettings = {
    revision: number;
    ai: AdminAISettings;
};

export async function fetchAdminSettings() {
    return apiGet<AdminSettings>("/api/admin/settings");
}

export async function saveAdminSettings(settings: AdminSettings) {
    return apiPost<AdminSettings>("/api/admin/settings", settings);
}

export async function fetchAIProviderTypes() {
    return apiGet<AdminAIProviderType[]>("/api/admin/ai/provider-types");
}
