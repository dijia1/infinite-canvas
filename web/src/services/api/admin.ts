import { apiDelete, apiGet, apiPost, compactApiParams } from "@/services/api/request";

export const ADMIN_AUTH_TOKEN_KEY = "infinite-canvas-admin-auth-token-v1";

export type AdminUser = {
    id: string;
    username: string;
    role: "admin";
};

export type AdminSession = {
    token: string;
    user: AdminUser;
};

export async function loginAdmin(payload: { username: string; password: string }) {
    return apiPost<AdminSession>("/api/admin/login", payload);
}

export async function fetchCurrentAdmin(token: string) {
    return apiGet<AdminUser>("/api/admin/me", undefined, token);
}

export type AdminAsset = {
    id: string;
    title: string;
    type: "text" | "image" | "video";
    coverUrl: string;
    tags: string[];
    category: string;
    description: string;
    content: string;
    url: string;
    createdAt: string;
    updatedAt: string;
};

export type AdminAssetListResponse = {
    items: AdminAsset[];
    tags: string[];
    total: number;
};

export type AdminAssetQuery = {
    keyword?: string;
    type?: string;
    tag?: string[];
    page?: number;
    pageSize?: number;
};

export async function fetchAdminAssets(token: string, query: AdminAssetQuery = {}) {
    return apiGet<AdminAssetListResponse>("/api/admin/assets", compactApiParams(query), token);
}

export async function saveAdminAsset(token: string, asset: Partial<AdminAsset>) {
    return apiPost<AdminAsset>("/api/admin/assets", asset, token);
}

export async function deleteAdminAsset(token: string, id: string) {
    return apiDelete<boolean>(`/api/admin/assets/${encodeURIComponent(id)}`, token);
}

export type AdminAIProvider = {
    id: string;
    name: string;
    type: string;
    enabled: boolean;
    config: Record<string, unknown>;
};

export type AdminAIProviderType = {
    id: string;
    name: string;
    capabilities: Array<"image_generate" | "image_edit" | "video_generate">;
    configFields: Array<{ key: string; label: string; type: "text" | "password"; placeholder?: string; required: boolean }>;
};

export type AdminAISettings = {
    providers: AdminAIProvider[];
    imageProviderId: string;
    videoProviderId: string;
};

export type AdminSettings = {
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
