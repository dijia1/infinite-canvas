import { apiGet, apiPost } from "@/services/api/request";
import type { ImageRequestSchema } from "@/lib/image-request-schema";
import type { ImageResolutionPrice } from "@/lib/image-pricing";

export const ADMIN_AUTH_TOKEN_KEY = "infinite-canvas-admin-auth-token-v1";

export type AdminUser = {
    id: string;
    username: string;
    role: "admin";
};

export async function fetchCurrentAdmin(token: string) {
    return apiGet<AdminUser>("/api/admin/me", undefined, token);
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

export async function fetchAdminSettings(token: string) {
    return apiGet<AdminSettings>("/api/admin/settings", undefined, token);
}

export async function saveAdminSettings(token: string, settings: AdminSettings) {
    return apiPost<AdminSettings>("/api/admin/settings", settings, token);
}

export async function fetchAIProviderTypes(token: string) {
    return apiGet<AdminAIProviderType[]>("/api/admin/ai/provider-types", undefined, token);
}
