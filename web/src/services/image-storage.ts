"use client";

import localforage from "localforage";
import { nanoid } from "nanoid";

import { appApiPath } from "@/lib/app-path";
import { readImageMeta } from "@/lib/image-utils";
import { portalStorageScope } from "@/lib/portal-storage-scope";
import { imageBlobFromResponse } from "./image-blob";
import { coalesceMediaLoad, resolveOriginal, resolvePreview } from "./media-cache-policy";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
    mediaId?: string;
};

export interface ImageCacheStore {
    getItem<T>(key: string): Promise<T | null>;
    setItem<T>(key: string, value: T): Promise<T>;
    removeItem(key: string): Promise<void>;
    iterate<T, U>(iterator: (value: T, key: string, iterationNumber: number) => U | void): Promise<U | undefined>;
}

type ImageMeta = { width: number; height: number; mimeType: string };
type PreviewMetadata = { bytes: number; lastAccess: number };
type CachedVariant = { blob: Blob; storageKey: string; generation: number };
export type RemoteMediaURL = string | (() => Promise<string>);

export type ImageStorageOperationsOptions = {
    scope: string;
    scopeVersion: number;
    store: ImageCacheStore;
    objectUrls: Map<string, string>;
    isActive: () => boolean;
    fetchImageBlob?: (url: string) => Promise<Blob>;
    createPreviewBlob?: (blob: Blob) => Promise<Blob>;
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
    readMeta?: (url: string) => Promise<ImageMeta>;
    now?: () => number;
    previewBudgetBytes?: number;
};

const PREVIEW_METADATA_PREFIX = "preview-meta:";
const DEFAULT_PREVIEW_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const inFlightStorageKeyCounts = new Map<string, number>();
const storageKeyGenerations = new Map<string, number>();
const storageKeyWriteRevisions = new Map<string, number>();
const storageKeyMutationTails = new Map<string, Promise<void>>();
const previewBudgetEnforcementSchedules = new Set<string>();

let scopeVersion = 1;
let activeContext = createImageStorageContext(portalStorageScope(), scopeVersion);

function createImageStore(scope: string) {
    return localforage.createInstance({ name: "infinite-canvas", storeName: `image_files_${scope.replace(/[^a-zA-Z0-9_-]/g, "_")}` });
}

function createImageStorageContext(scope: string, version: number) {
    return {
        scope,
        scopeVersion: version,
        store: createImageStore(scope) as ImageCacheStore,
        objectUrls: new Map<string, string>(),
    };
}

function currentOperations() {
    const context = activeContext;
    return createImageStorageOperations({ ...context, isActive: () => activeContext === context });
}

export function setImageStorageScope(uid?: string) {
    const nextScope = portalStorageScope(uid);
    if (nextScope === activeContext.scope) return;
    activeContext.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    activeContext.objectUrls.clear();
    scopeVersion += 1;
    activeContext = createImageStorageContext(nextScope, scopeVersion);
}

export function imageStorageKeyForMedia(mediaId: string) {
    return `media:${mediaId}`;
}

export function imagePreviewStorageKey(mediaId: string) {
    return `preview:${mediaId}`;
}

function previewMetadataKey(storageKey: string) {
    return `${PREVIEW_METADATA_PREFIX}${storageKey.slice("preview:".length)}`;
}

function expandExplicitDeletionKeys(keys: Iterable<string>) {
    const expanded = new Set<string>();
    for (const key of keys) {
        expanded.add(key);
        if (key.startsWith("media:")) {
            const previewKey = imagePreviewStorageKey(key.slice("media:".length));
            expanded.add(previewKey);
            expanded.add(previewMetadataKey(previewKey));
        } else if (key.startsWith("preview:")) {
            expanded.add(previewMetadataKey(key));
        }
    }
    return expanded;
}

function scopedLoadKey(options: ImageStorageOperationsOptions, storageKey: string) {
    return `${options.scope}@${options.scopeVersion}:${storageKey}`;
}

function physicalStorageKey(options: ImageStorageOperationsOptions, storageKey: string) {
    return `${options.scope}:${storageKey}`;
}

function ensureActive(options: ImageStorageOperationsOptions) {
    if (!options.isActive()) throw new Error("图片缓存作用域已切换，请重试");
}

async function resolveRemoteURL(value: RemoteMediaURL) {
    return typeof value === "string" ? value : value();
}

export function createImageStorageOperations(options: ImageStorageOperationsOptions) {
    const fetchImageBlob = options.fetchImageBlob || (async (url: string) => imageBlobFromResponse(await fetch(appApiPath(url))));
    const createPreviewBlob = options.createPreviewBlob || createImagePreview;
    const createObjectURL = options.createObjectURL || ((blob: Blob) => URL.createObjectURL(blob));
    const revokeObjectURL = options.revokeObjectURL || ((url: string) => URL.revokeObjectURL(url));
    const readMeta = options.readMeta || readImageMeta;
    const now = options.now || Date.now;
    const previewBudgetBytes = options.previewBudgetBytes ?? DEFAULT_PREVIEW_CACHE_BUDGET_BYTES;
    const previewBudgetScheduleKey = `${options.scope}@${options.scopeVersion}`;

    const generationKey = (storageKey: string) => physicalStorageKey(options, storageKey);
    const currentGeneration = (storageKey: string) => storageKeyGenerations.get(generationKey(storageKey)) || 0;
    const invalidateKey = (storageKey: string) => storageKeyGenerations.set(generationKey(storageKey), currentGeneration(storageKey) + 1);
    const currentWriteRevision = (storageKey: string) => storageKeyWriteRevisions.get(generationKey(storageKey)) || 0;
    const bumpWriteRevision = (storageKey: string) => storageKeyWriteRevisions.set(generationKey(storageKey), currentWriteRevision(storageKey) + 1);
    const ensureGeneration = (storageKey: string, generation: number) => {
        if (currentGeneration(storageKey) !== generation) throw new Error("图片缓存已删除，请重新加载");
    };
    const withStorageMutation = async <T>(storageKey: string, mutation: () => Promise<T>) => {
        const key = physicalStorageKey(options, storageKey);
        const previous = storageKeyMutationTails.get(key) || Promise.resolve();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        storageKeyMutationTails.set(key, tail);
        await previous.catch(() => undefined);
        try {
            return await mutation();
        } finally {
            release();
            if (storageKeyMutationTails.get(key) === tail) {
                void tail.then(() => {
                    if (storageKeyMutationTails.get(key) === tail) storageKeyMutationTails.delete(key);
                });
            }
        }
    };
    const withStorageMutations = async <T>(storageKeys: Iterable<string>, mutation: () => Promise<T>): Promise<T> => {
        const keys = Array.from(new Set(storageKeys)).sort((left, right) => physicalStorageKey(options, left).localeCompare(physicalStorageKey(options, right)));
        const run = async (index: number): Promise<T> => {
            if (index >= keys.length) return mutation();
            return withStorageMutation(keys[index], () => run(index + 1));
        };
        return run(0);
    };

    const markInFlight = (storageKeys: string[]) => {
        const keys = storageKeys.map((key) => physicalStorageKey(options, key));
        keys.forEach((key) => inFlightStorageKeyCounts.set(key, (inFlightStorageKeyCounts.get(key) || 0) + 1));
        return () =>
            keys.forEach((key) => {
                const remaining = (inFlightStorageKeyCounts.get(key) || 1) - 1;
                if (remaining > 0) inFlightStorageKeyCounts.set(key, remaining);
                else inFlightStorageKeyCounts.delete(key);
            });
    };
    const isInFlight = (storageKey: string) => (inFlightStorageKeyCounts.get(physicalStorageKey(options, storageKey)) || 0) > 0;

    const replaceObjectURL = (storageKey: string, blob: Blob) => {
        const previous = options.objectUrls.get(storageKey);
        const url = createObjectURL(blob);
        options.objectUrls.set(storageKey, url);
        if (previous && previous !== url) revokeObjectURL(previous);
        return url;
    };
    const resolveBlobURL = (storageKey: string, blob: Blob) => options.objectUrls.get(storageKey) || replaceObjectURL(storageKey, blob);

    const touchPreviewMetadata = async (storageKey: string, bytes: number, generation: number) =>
        withStorageMutation(previewMetadataKey(storageKey), async () => {
            ensureActive(options);
            ensureGeneration(storageKey, generation);
            await options.store.setItem<PreviewMetadata>(previewMetadataKey(storageKey), { bytes, lastAccess: now() });
            try {
                ensureActive(options);
                ensureGeneration(storageKey, generation);
            } catch (error) {
                await options.store.removeItem(previewMetadataKey(storageKey));
                throw error;
            }
        });
    const touchPreview = async (storageKey: string, blob: Blob, generation: number) => touchPreviewMetadata(storageKey, blob.size, generation);
    const touchPreviewWithoutBlockingDisplay = async (storageKey: string, blob: Blob, generation: number) => {
        try {
            await touchPreview(storageKey, blob, generation);
        } catch (error) {
            if (currentGeneration(storageKey) === generation) console.warn("更新图片预览缓存元数据失败", error instanceof Error ? error.message : String(error));
        }
    };
    const touchCachedPreviewWithoutBlockingDisplay = async (storageKey: string, generation: number) => {
        try {
            ensureActive(options);
            ensureGeneration(storageKey, generation);
            const metadata = await options.store.getItem<PreviewMetadata>(previewMetadataKey(storageKey));
            ensureActive(options);
            ensureGeneration(storageKey, generation);
            if (metadata && Number.isFinite(metadata.bytes)) {
                await touchPreviewMetadata(storageKey, metadata.bytes, generation);
                return;
            }
            const blob = await options.store.getItem<Blob>(storageKey);
            if (blob) await touchPreview(storageKey, blob, generation);
        } catch (error) {
            if (options.isActive() && currentGeneration(storageKey) === generation) console.warn("更新图片预览缓存元数据失败", error instanceof Error ? error.message : String(error));
        }
    };
    const readBlob = async (storageKey: string, generation = currentGeneration(storageKey)) => {
        const blob = await options.store.getItem<Blob>(storageKey);
        ensureActive(options);
        ensureGeneration(storageKey, generation);
        if (blob && storageKey.startsWith("preview:")) void touchPreviewWithoutBlockingDisplay(storageKey, blob, generation);
        ensureActive(options);
        return blob || undefined;
    };
    const clearInvalidatedWrite = async (storageKey: string) => {
        const url = options.objectUrls.get(storageKey);
        if (url) revokeObjectURL(url);
        options.objectUrls.delete(storageKey);
        await options.store.removeItem(storageKey);
        if (storageKey.startsWith("preview:")) await options.store.removeItem(previewMetadataKey(storageKey));
        bumpWriteRevision(storageKey);
    };
    const writeBlobUnlocked = async (storageKey: string, blob: Blob, generation: number) => {
        ensureActive(options);
        ensureGeneration(storageKey, generation);
        await options.store.setItem(storageKey, blob);
        try {
            ensureActive(options);
            ensureGeneration(storageKey, generation);
        } catch (error) {
            await clearInvalidatedWrite(storageKey);
            throw error;
        }
        const previousURL = options.objectUrls.get(storageKey);
        if (previousURL) {
            options.objectUrls.delete(storageKey);
            revokeObjectURL(previousURL);
        }
        bumpWriteRevision(storageKey);
        if (storageKey.startsWith("preview:")) {
            void touchPreviewWithoutBlockingDisplay(storageKey, blob, generation);
        }
        ensureActive(options);
        ensureGeneration(storageKey, generation);
        return blob;
    };
    const writeBlob = async (storageKey: string, blob: Blob, generation = currentGeneration(storageKey)) =>
        withStorageMutation(storageKey, () => writeBlobUnlocked(storageKey, blob, generation));
    const toUploadedImage = async (variant: CachedVariant, mediaId?: string): Promise<UploadedImage> => {
        ensureActive(options);
        ensureGeneration(variant.storageKey, variant.generation);
        const url = resolveBlobURL(variant.storageKey, variant.blob);
        try {
            const meta = await readMeta(url);
            ensureActive(options);
            ensureGeneration(variant.storageKey, variant.generation);
            return {
                url,
                storageKey: variant.storageKey,
                width: meta.width,
                height: meta.height,
                bytes: variant.blob.size,
                mimeType: variant.blob.type || meta.mimeType,
                mediaId,
            };
        } catch (error) {
            if (options.objectUrls.get(variant.storageKey) === url) {
                options.objectUrls.delete(variant.storageKey);
                revokeObjectURL(url);
            }
            throw error;
        }
    };

    const loadMediaImage = (mediaId: string, remoteURL: RemoteMediaURL) => {
        const storageKey = imageStorageKeyForMedia(mediaId);
        const generation = currentGeneration(storageKey);
        return coalesceMediaLoad(`${scopedLoadKey(options, storageKey)}#${generation}`, async () => {
            const finish = markInFlight([storageKey]);
            try {
                const variant = await resolveOriginal<CachedVariant>({
                    readOriginal: async () => {
                        const blob = await readBlob(storageKey, generation);
                        return blob ? { blob, storageKey, generation } : undefined;
                    },
                    loadRemoteOriginal: async () => {
                        const blob = await fetchImageBlob(await resolveRemoteURL(remoteURL));
                        ensureActive(options);
                        await writeBlob(storageKey, blob, generation);
                        return { blob, storageKey, generation };
                    },
                });
                return await toUploadedImage(variant, mediaId);
            } finally {
                finish();
            }
        });
    };

    const loadMediaPreview = (mediaId: string, remotePreviewURL: RemoteMediaURL) => {
        const previewKey = imagePreviewStorageKey(mediaId);
        const originalKey = imageStorageKeyForMedia(mediaId);
        const previewGeneration = currentGeneration(previewKey);
        const originalGeneration = currentGeneration(originalKey);
        return coalesceMediaLoad(`${scopedLoadKey(options, previewKey)}#${previewGeneration}.${originalGeneration}`, async () => {
            const finish = markInFlight([previewKey, originalKey]);
            try {
                const variant = await resolvePreview<CachedVariant>({
                    readPreview: async () => {
                        const blob = await readBlob(previewKey, previewGeneration);
                        return blob ? { blob, storageKey: previewKey, generation: previewGeneration } : undefined;
                    },
                    readOriginal: async () => {
                        const blob = await readBlob(originalKey, originalGeneration);
                        return blob ? { blob, storageKey: originalKey, generation: originalGeneration } : undefined;
                    },
                    createPreview: async (original) => {
                        const blob = await createPreviewBlob(original.blob);
                        await writeBlob(previewKey, blob, previewGeneration);
                        return { blob, storageKey: previewKey, generation: previewGeneration };
                    },
                    loadRemotePreview: async () => {
                        const blob = await fetchImageBlob(await resolveRemoteURL(remotePreviewURL));
                        ensureActive(options);
                        await writeBlob(previewKey, blob, previewGeneration);
                        return { blob, storageKey: previewKey, generation: previewGeneration };
                    },
                });
                return await toUploadedImage(variant, mediaId);
            } finally {
                finish();
                schedulePreviewCacheBudgetEnforcement();
            }
        });
    };

    const storeImage = async (input: string | Blob, storageKey: string, mediaId?: string) => {
        const generation = currentGeneration(storageKey);
        const finish = markInFlight([storageKey]);
        try {
            const blob = typeof input === "string" ? await fetchImageBlob(input) : input;
            await writeBlob(storageKey, blob, generation);
            return await toUploadedImage({ blob, storageKey, generation }, mediaId);
        } finally {
            finish();
        }
    };
    const resolveImageUrl = async (storageKey?: string, fallback = "") => {
        if (!storageKey) return fallback;
        const cached = options.objectUrls.get(storageKey);
        if (cached) {
            if (storageKey.startsWith("preview:")) void touchCachedPreviewWithoutBlockingDisplay(storageKey, currentGeneration(storageKey));
            return cached;
        }
        const blob = await readBlob(storageKey);
        return blob ? resolveBlobURL(storageKey, blob) : fallback;
    };
    const getImageBlob = async (storageKey: string) => (await readBlob(storageKey)) || null;
    const setImageBlob = async (storageKey: string, blob: Blob) => {
        const generation = currentGeneration(storageKey);
        const finish = markInFlight([storageKey]);
        try {
            await writeBlob(storageKey, blob, generation);
            ensureGeneration(storageKey, generation);
            return replaceObjectURL(storageKey, blob);
        } finally {
            finish();
        }
    };
    const promoteImageStorageKey = async (image: UploadedImage, mediaId: string): Promise<UploadedImage> => {
        const targetKey = imageStorageKeyForMedia(mediaId);
        if (image.storageKey === targetKey) return { ...image, storageKey: targetKey, mediaId };
        const sourceGeneration = currentGeneration(image.storageKey);
        const targetGeneration = currentGeneration(targetKey);
        const finish = markInFlight([image.storageKey, targetKey]);
        try {
            return await withStorageMutations([image.storageKey, targetKey], async () => {
                ensureActive(options);
                ensureGeneration(image.storageKey, sourceGeneration);
                ensureGeneration(targetKey, targetGeneration);
                const blob = await options.store.getItem<Blob>(image.storageKey);
                ensureActive(options);
                ensureGeneration(image.storageKey, sourceGeneration);
                ensureGeneration(targetKey, targetGeneration);
                if (!blob) throw new Error("本地图片缓存不存在，无法完成上传");

                await writeBlobUnlocked(targetKey, blob, targetGeneration);
                try {
                    ensureActive(options);
                    ensureGeneration(image.storageKey, sourceGeneration);
                    ensureGeneration(targetKey, targetGeneration);
                } catch (error) {
                    await clearInvalidatedWrite(targetKey);
                    throw error;
                }

                const sourceURL = options.objectUrls.get(image.storageKey);
                const url = sourceURL || replaceObjectURL(targetKey, blob);
                if (sourceURL) {
                    options.objectUrls.delete(image.storageKey);
                    options.objectUrls.set(targetKey, sourceURL);
                }
                await options.store.removeItem(image.storageKey);
                invalidateKey(image.storageKey);
                bumpWriteRevision(image.storageKey);
                ensureActive(options);
                ensureGeneration(targetKey, targetGeneration);
                return { ...image, url, storageKey: targetKey, mediaId };
            });
        } finally {
            finish();
        }
    };
    const deleteExactKey = async (key: string) => {
        const url = options.objectUrls.get(key);
        if (url) revokeObjectURL(url);
        options.objectUrls.delete(key);
        await options.store.removeItem(key);
        if (!key.startsWith(PREVIEW_METADATA_PREFIX)) bumpWriteRevision(key);
    };
    const deleteExactKeys = async (keys: Iterable<string>, shouldDelete?: (key: string) => boolean) => {
        await Promise.all(
            Array.from(new Set(keys)).map((key) =>
                withStorageMutation(key, async () => {
                    if (shouldDelete && !shouldDelete(key)) return;
                    await deleteExactKey(key);
                }),
            ),
        );
    };
    const deleteStoredImages = async (keys: Iterable<string>) => {
        const expanded = expandExplicitDeletionKeys(keys);
        expanded.forEach((key) => {
            if (!key.startsWith(PREVIEW_METADATA_PREFIX)) invalidateKey(key);
        });
        await deleteExactKeys(expanded);
    };

    const enforcePreviewCacheBudget = async () => {
        const previews: Array<{ storageKey: string; bytes: number; lastAccess: number; revision: number }> = [];
        const previewMetadata = new Map<string, PreviewMetadata>();
        ensureActive(options);
        await options.store.iterate<unknown, void>((value, key) => {
            if (key.startsWith(PREVIEW_METADATA_PREFIX)) {
                previewMetadata.set(`preview:${key.slice(PREVIEW_METADATA_PREFIX.length)}`, value as PreviewMetadata);
                return;
            }
            if (key.startsWith("preview:")) {
                const blob = value as Blob;
                previews.push({ storageKey: key, bytes: blob.size || 0, lastAccess: 0, revision: currentWriteRevision(key) });
            }
        });
        ensureActive(options);

        for (const preview of previews) {
            const metadata = previewMetadata.get(preview.storageKey);
            if (metadata) Object.assign(preview, metadata);
        }
        let previewBytes = previews.reduce((total, preview) => total + preview.bytes, 0);
        if (previewBytes <= previewBudgetBytes) return;

        const evicted: Array<{ storageKey: string; revision: number }> = [];
        for (const preview of previews.filter((candidate) => !isInFlight(candidate.storageKey)).sort((left, right) => left.lastAccess - right.lastAccess)) {
            if (previewBytes <= previewBudgetBytes) break;
            if (isInFlight(preview.storageKey)) continue;
            previewBytes -= preview.bytes;
            evicted.push(preview);
        }
        const evictedRevisions = new Map(evicted.map(({ storageKey, revision }) => [storageKey, revision]));
        await deleteExactKeys(
            Array.from(evictedRevisions.keys()).flatMap((storageKey) => [storageKey, previewMetadataKey(storageKey)]),
            (storageKey) => {
                const previewKey = storageKey.startsWith(PREVIEW_METADATA_PREFIX) ? `preview:${storageKey.slice(PREVIEW_METADATA_PREFIX.length)}` : storageKey;
                return options.isActive() && !isInFlight(previewKey) && currentWriteRevision(previewKey) === evictedRevisions.get(previewKey);
            },
        );
    };
    const schedulePreviewCacheBudgetEnforcement = () => {
        if (previewBudgetEnforcementSchedules.has(previewBudgetScheduleKey)) return;
        previewBudgetEnforcementSchedules.add(previewBudgetScheduleKey);
        const run = () => {
            previewBudgetEnforcementSchedules.delete(previewBudgetScheduleKey);
            void enforcePreviewCacheBudget().catch((error) => {
                console.warn("清理图片预览缓存失败", error instanceof Error ? error.message : String(error));
            });
        };
        if (typeof requestIdleCallback === "function") requestIdleCallback(run);
        else setTimeout(run, 0);
    };

    const cleanupUnusedImages = async (usedData: unknown) => {
        const usedKeys = collectImageStorageKeys(usedData);
        const unusedOriginals: Array<{ storageKey: string; revision: number }> = [];
        await options.store.iterate<unknown, void>((value, key) => {
            if (key.startsWith(PREVIEW_METADATA_PREFIX) || key.startsWith("preview:")) return;
            if (!usedKeys.has(key) && !isInFlight(key)) unusedOriginals.push({ storageKey: key, revision: currentWriteRevision(key) });
        });
        const unusedOriginalRevisions = new Map(unusedOriginals.map(({ storageKey, revision }) => [storageKey, revision]));
        await deleteExactKeys(
            unusedOriginalRevisions.keys(),
            (storageKey) => !isInFlight(storageKey) && currentWriteRevision(storageKey) === unusedOriginalRevisions.get(storageKey),
        );
        await enforcePreviewCacheBudget();
    };

    return { loadMediaImage, loadMediaPreview, storeImage, resolveImageUrl, getImageBlob, setImageBlob, promoteImageStorageKey, deleteStoredImages, cleanupUnusedImages, enforcePreviewCacheBudget };
}

export async function createImagePreview(blob: Blob) {
    if (typeof createImageBitmap !== "function") throw new Error("当前浏览器不支持本地图片缩略图转换");
    const bitmap = await createImageBitmap(blob);
    try {
        const width = Math.max(1, Math.min(320, bitmap.width));
        const height = Math.max(1, Math.round((bitmap.height / bitmap.width) * width));
        if (typeof OffscreenCanvas !== "undefined") {
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext("2d");
            if (!context) throw new Error("无法创建图片缩略图画布");
            context.drawImage(bitmap, 0, 0, width, height);
            const preview = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
            if (preview.type !== "image/webp") throw new Error("浏览器未能生成 WebP 缩略图");
            return preview;
        }
        if (typeof document === "undefined") throw new Error("当前环境不支持图片缩略图转换");
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法创建图片缩略图画布");
        context.drawImage(bitmap, 0, 0, width, height);
        return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
                (preview) => {
                    if (!preview) return reject(new Error("图片缩略图转换失败"));
                    if (preview.type !== "image/webp") return reject(new Error("浏览器未能生成 WebP 缩略图"));
                    resolve(preview);
                },
                "image/webp",
                0.8,
            );
        });
    } finally {
        bitmap.close();
    }
}

export async function uploadImage(input: string | Blob, mediaId?: string): Promise<UploadedImage> {
    const operations = currentOperations();
    const storageKey = mediaId ? imageStorageKeyForMedia(mediaId) : `image:${nanoid()}`;
    return operations.storeImage(input, storageKey, mediaId);
}

export async function loadMediaImage(mediaId: string, remoteURL: RemoteMediaURL): Promise<UploadedImage> {
    return currentOperations().loadMediaImage(mediaId, remoteURL);
}

export async function loadMediaPreview(mediaId: string, remotePreviewURL: RemoteMediaURL): Promise<UploadedImage> {
    return currentOperations().loadMediaPreview(mediaId, remotePreviewURL);
}

export async function promoteImageStorageKey(image: UploadedImage, mediaId: string): Promise<UploadedImage> {
    return currentOperations().promoteImageStorageKey(image, mediaId);
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
    return currentOperations().resolveImageUrl(storageKey, fallback);
}

export async function getImageBlob(storageKey: string) {
    return currentOperations().getImageBlob(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    return currentOperations().setImageBlob(storageKey, blob);
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const operations = currentOperations();
    const cachedBlob = image.storageKey ? await operations.getImageBlob(image.storageKey) : null;
    if (cachedBlob) return blobToDataUrl(cachedBlob);
    const url = image.dataUrl || image.url || "";
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(url)).blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
    return currentOperations().deleteStoredImages(keys);
}

export async function cleanupUnusedImages(usedData: unknown) {
    return currentOperations().cleanupUnusedImages(usedData);
}

export async function enforcePreviewCacheBudget() {
    return currentOperations().enforcePreviewCacheBudget();
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
