"use client";

import localforage from "localforage";

import { nanoid } from "nanoid";
import { appApiPath } from "@/lib/app-path";
import { readImageMeta } from "@/lib/image-utils";
import { portalStorageScope } from "@/lib/portal-storage-scope";
import { imageBlobFromResponse } from "./image-blob";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
	mediaId?: string;
};

let imageStorageScope = portalStorageScope();
let store = createImageStore(imageStorageScope);
const objectUrls = new Map<string, string>();

function createImageStore(scope: string) {
    return localforage.createInstance({ name: "infinite-canvas", storeName: `image_files_${scope.replace(/[^a-zA-Z0-9_-]/g, "_")}` });
}

export function setImageStorageScope(uid?: string) {
    const nextScope = portalStorageScope(uid);
    if (nextScope === imageStorageScope) return;
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
    imageStorageScope = nextScope;
    store = createImageStore(nextScope);
}

export function imageStorageKeyForMedia(mediaId: string) {
    return `media:${mediaId}`;
}

export function imagePreviewStorageKey(mediaId: string) {
    return `preview:${mediaId}`;
}

export async function uploadImage(input: string | Blob, mediaId?: string): Promise<UploadedImage> {
    const storageKey = mediaId ? imageStorageKeyForMedia(mediaId) : `image:${nanoid()}`;
    return storeImage(input, storageKey, mediaId);
}

export async function uploadImagePreview(input: string, mediaId: string): Promise<UploadedImage> {
    return storeImage(input, imagePreviewStorageKey(mediaId), mediaId);
}

async function storeImage(input: string | Blob, storageKey: string, mediaId?: string): Promise<UploadedImage> {
    const blob = typeof input === "string" ? await imageBlobFromResponse(await fetch(appApiPath(input))) : input;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = await readImageMeta(url);
    return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType, mediaId };
}

export async function promoteImageStorageKey(image: UploadedImage, mediaId: string): Promise<UploadedImage> {
    const blob = await store.getItem<Blob>(image.storageKey);
    if (!blob) throw new Error("本地图片缓存不存在，无法完成上传");

    const storageKey = imageStorageKeyForMedia(mediaId);
    await store.setItem(storageKey, blob);

    const url = objectUrls.get(image.storageKey) || URL.createObjectURL(blob);
    objectUrls.delete(image.storageKey);
    objectUrls.set(storageKey, url);
    await store.removeItem(image.storageKey);

    return { ...image, url, storageKey, mediaId };
}

export type RemoteImageAccess = { url: string; previewUrl?: string };

export async function getRemoteImageAccess(mediaId: string): Promise<RemoteImageAccess> {
    const response = await fetch(appApiPath(`/api/v1/media/${encodeURIComponent(mediaId)}/access`));
    const payload = (await response.json()) as { code: number; data?: RemoteImageAccess; msg?: string };
    if (!response.ok || payload.code !== 0 || !payload.data?.url) throw new Error(payload.msg || "获取图片访问地址失败");
    return payload.data;
}

export async function resolveRemoteImage(mediaId: string) {
    return (await getRemoteImageAccess(mediaId)).url;
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(url)).blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string") {
        const storageKey = value.storageKey;
        if (storageKey.startsWith("image:")) keys.add(storageKey);
        if (storageKey.startsWith("media:")) {
            keys.add(storageKey);
            keys.add(imagePreviewStorageKey(storageKey.slice("media:".length)));
        }
    }
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}
