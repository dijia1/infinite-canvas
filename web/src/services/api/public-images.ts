import axios from "axios";

import { appApiPath } from "@/lib/app-path";
import { apiGet, apiPost, compactApiParams } from "@/services/api/request";

export type PublicImage = {
    id: string;
    mediaId: string;
    title: string;
    folderId?: string;
    uploaderUid: string;
    createdAt: string;
};

export type PublicImageList = {
    items: PublicImage[];
    total: number;
};

export type PublicImageFolder = {
    id: string;
    title: string;
    parentId?: string;
    createdAt: string;
};

export type PublicImageFolderList = {
    items: PublicImageFolder[];
    total: number;
};

export async function fetchPublicImages(query: { keyword?: string; folderId?: string; page?: number; pageSize?: number } = {}) {
    return apiGet<PublicImageList>("/api/v1/public-images", compactApiParams(query));
}

export async function fetchPublicImageFolders() {
    return apiGet<PublicImageFolderList>("/api/v1/public-folders");
}

export async function fetchPublicImageAccess(id: string) {
    const response = await fetch(appApiPath(`/api/v1/public-images/${encodeURIComponent(id)}/access`), { cache: "no-store" });
    const payload = (await response.json()) as { code?: number; data?: { mediaId: string; url: string; previewUrl?: string; contentType: string; bytes: number; width: number; height: number }; msg?: string };
    if (!response.ok || payload.code !== 0 || !payload.data?.url) throw new Error(payload.msg || "获取公共图片访问地址失败");
    return payload.data;
}

export async function uploadAdminPublicImage(file: File, title: string, folderId?: string) {
    const data = new FormData();
    data.append("image", file);
    data.append("title", title);
    if (folderId) data.append("folderId", folderId);
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

export async function createAdminPublicImageFolder(title: string, parentId?: string) {
    return apiPost<PublicImageFolder>("/api/admin/public-folders", { title, parentId: parentId || "" });
}

export async function updateAdminPublicImageFolder(id: string, title: string) {
    const response = await axios.patch(appApiPath(`/api/admin/public-folders/${encodeURIComponent(id)}`), { title }, { validateStatus: () => true });
    const payload = response.data as { code?: number; data?: PublicImageFolder; msg?: string };
    if (response.status < 200 || response.status >= 300 || payload?.code !== 0 || !payload.data) throw new Error(payload?.msg || "重命名公共文件夹失败");
    return payload.data;
}

export async function deleteAdminPublicImageFolder(id: string) {
    const response = await axios.delete(appApiPath(`/api/admin/public-folders/${encodeURIComponent(id)}`), { validateStatus: () => true });
    const payload = response.data as { code?: number; msg?: string };
    if (response.status < 200 || response.status >= 300 || payload?.code !== 0) throw new Error(payload?.msg || "删除公共文件夹失败");
}

export async function updateAdminPublicImage(id: string, patch: { title?: string; folderId?: string }) {
    const response = await axios.patch(appApiPath(`/api/admin/public-images/${encodeURIComponent(id)}`), patch, { validateStatus: () => true });
    const payload = response.data as { code?: number; data?: PublicImage; msg?: string };
    if (response.status < 200 || response.status >= 300 || payload?.code !== 0 || !payload.data) throw new Error(payload?.msg || "更新公共图片失败");
    return payload.data;
}
