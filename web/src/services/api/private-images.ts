import { apiDelete, apiGet, apiPatch, apiPost } from "./request";

export type PrivateImage = {
    id: string;
    source: "upload" | "generated";
    contentType: string;
    bytes: number;
    width: number;
    height: number;
    filename: string;
    title: string;
    folderId?: string;
    createdAt: string;
};

export type PrivateFolder = {
    id: string;
    title: string;
    parentId?: string;
    createdAt: string;
};

export type PrivateImageList = { items: PrivateImage[]; total: number };
export type PrivateFolderList = { items: PrivateFolder[]; total: number };

export function fetchPrivateImages() {
    return apiGet<PrivateImageList>("/api/v1/private-images");
}

export function fetchPrivateFolders() {
    return apiGet<PrivateFolderList>("/api/v1/private-folders");
}

export function updatePrivateImage(id: string, patch: { title?: string; folderId?: string }) {
    return apiPatch<PrivateImage>(`/api/v1/private-images/${encodeURIComponent(id)}`, patch);
}

export function createPrivateFolder(input: { title: string; parentId?: string }) {
    return apiPost<PrivateFolder>("/api/v1/private-folders", input);
}

export function renamePrivateFolder(id: string, title: string) {
    return apiPatch<PrivateFolder>(`/api/v1/private-folders/${encodeURIComponent(id)}`, { title });
}

export function deletePrivateFolder(id: string) {
    return apiDelete<void>(`/api/v1/private-folders/${encodeURIComponent(id)}`);
}
