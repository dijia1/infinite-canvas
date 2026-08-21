import axios from "axios";

import { appApiPath } from "@/lib/app-path";
import { apiGet, compactApiParams } from "@/services/api/request";

export type PublicImage = {
    id: string;
    mediaId: string;
    title: string;
    uploaderUid: string;
    createdAt: string;
};

export type PublicImageList = {
    items: PublicImage[];
    total: number;
};

export async function fetchPublicImages(query: { keyword?: string; page?: number; pageSize?: number } = {}) {
    return apiGet<PublicImageList>("/api/v1/public-images", compactApiParams(query));
}

export async function fetchPublicImageAccess(id: string) {
    return apiGet<{ mediaId: string; url: string; previewUrl?: string; contentType: string; bytes: number; width: number; height: number }>(`/api/v1/public-images/${encodeURIComponent(id)}/access`);
}

export async function uploadAdminPublicImage(file: File, title: string) {
    const data = new FormData();
    data.append("image", file);
    data.append("title", title);
    const response = await axios.post(appApiPath("/api/admin/public-images"), data, { validateStatus: () => true });
    const payload = response.data as { code?: number; data?: { item?: PublicImage }; msg?: string };
    if (response.status < 200 || response.status >= 300 || payload?.code !== 0 || !payload.data?.item) throw new Error(payload?.msg || "上传公共图片失败");
    return payload.data.item;
}

export async function deleteAdminPublicImage(id: string) {
    const response = await axios.delete(appApiPath(`/api/admin/public-images/${encodeURIComponent(id)}`), { validateStatus: () => true });
    const payload = response.data as { code?: number; msg?: string };
    if (response.status < 200 || response.status >= 300 || payload?.code !== 0) throw new Error(payload?.msg || "删除公共图片失败");
}
