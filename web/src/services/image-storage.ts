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
type CacheVariant = "thumbnail" | "original" | "temporary";
type CacheMetadata = { bytes: number; cachedAt: number; lastAccessedAt: number; variant: CacheVariant };
type LegacyCacheMetadata = Omit<Partial<CacheMetadata>, "variant"> & { lastAccess?: number; variant?: "preview" | CacheVariant };
type CacheTotal = { bytes: number; entries: number };
type CachedVariant = { blob: Blob; storageKey: string; generation: number };
export type RemoteMediaURL = string | (() => Promise<string>);
export type MediaLoadOptions = {
    signal?: AbortSignal;
    // Canvas overview rendering must not decode a cached 4K original merely to
    // synthesize a preview when OSS can provide one directly.
    preferRemoteThumbnail?: boolean;
};

export type ImageStorageOperationsOptions = {
    scope: string;
    scopeVersion: number;
    store: ImageCacheStore;
    cacheIndexStore?: ImageCacheStore;
    objectUrls: Map<string, string>;
    isActive: () => boolean;
    fetchImageBlob?: (url: string, options?: MediaLoadOptions) => Promise<Blob>;
    createPreviewBlob?: (blob: Blob) => Promise<Blob>;
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
    readMeta?: (url: string) => Promise<ImageMeta>;
    now?: () => number;
    cacheBudgetBytes?: number;
    cacheHighWatermarkBytes?: number;
    cacheLowWatermarkBytes?: number;
    cacheMaxEntries?: number;
    cacheHighWatermarkEntries?: number;
    cacheLowWatermarkEntries?: number;
};

const CACHE_METADATA_PREFIX = "cache-meta:";
const CACHE_TOTAL_KEY = "cache-total";
const GIB = 1024 * 1024 * 1024;
const DEFAULT_CACHE_BUDGET_BYTES = 2 * GIB;
const DEFAULT_CACHE_HIGH_WATERMARK_BYTES = Math.floor(1.8 * GIB);
const DEFAULT_CACHE_LOW_WATERMARK_BYTES = Math.floor(1.4 * GIB);
const DEFAULT_CACHE_MAX_ENTRIES = 10_000;
const DEFAULT_CACHE_HIGH_WATERMARK_ENTRIES = 9_000;
const DEFAULT_CACHE_LOW_WATERMARK_ENTRIES = 8_000;
const MEDIA_CACHE_VERSION = 1;
const inFlightStorageKeyCounts = new Map<string, number>();
const storageKeyGenerations = new Map<string, number>();
const storageKeyWriteRevisions = new Map<string, number>();
const storageKeyMutationTails = new Map<string, Promise<void>>();
const cacheBudgetEnforcementSchedules = new Set<string>();

let scopeVersion = 1;
let activeContext = createImageStorageContext(portalStorageScope(), scopeVersion);

function createImageStore(scope: string) {
    return localforage.createInstance({ name: "infinite-canvas", storeName: `image_files_${scope.replace(/[^a-zA-Z0-9_-]/g, "_")}` });
}

function createImageCacheIndexStore(scope: string) {
    return localforage.createInstance({ name: "infinite-canvas", storeName: `image_cache_index_${scope.replace(/[^a-zA-Z0-9_-]/g, "_")}` });
}

function createImageStorageContext(scope: string, version: number) {
    return {
        scope,
        scopeVersion: version,
        store: createImageStore(scope) as ImageCacheStore,
        cacheIndexStore: createImageCacheIndexStore(scope) as ImageCacheStore,
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
    return mediaCacheStorageKey(mediaId, "original");
}

export function imageThumbnailStorageKey(mediaId: string) {
    return mediaCacheStorageKey(mediaId, "thumbnail");
}

function mediaCacheStorageKey(mediaId: string, variant: "thumbnail" | "original") {
    return `media:${mediaId}:v${MEDIA_CACHE_VERSION}:${variant}`;
}

function cacheMetadataKey(storageKey: string) {
    return `${CACHE_METADATA_PREFIX}${storageKey}`;
}

function cacheVariant(storageKey: string): CacheVariant {
    if (storageKey.endsWith(":thumbnail")) return "thumbnail";
    return storageKey.startsWith("image:") ? "temporary" : "original";
}

function normalizeCacheMetadata(value: LegacyCacheMetadata | null): CacheMetadata | undefined {
    if (!value) return undefined;
    const bytes = Number(value.bytes);
    if (!Number.isFinite(bytes)) return undefined;
    const variant = value.variant === "preview" ? "thumbnail" : value.variant;
    if (variant !== "thumbnail" && variant !== "original" && variant !== "temporary") return undefined;
    const lastAccessedAt = Number.isFinite(value.lastAccessedAt) ? Number(value.lastAccessedAt) : Number.isFinite(value.lastAccess) ? Number(value.lastAccess) : 0;
    const cachedAt = Number.isFinite(value.cachedAt) ? Number(value.cachedAt) : lastAccessedAt;
    return {
        bytes: Math.max(0, bytes),
        cachedAt,
        lastAccessedAt,
        variant,
    };
}

function legacyStorageKey(storageKey: string) {
    const match = /^media:(.+):v1:(original|thumbnail)$/.exec(storageKey);
    if (!match) return undefined;
    return match[2] === "thumbnail" ? `preview:${match[1]}` : `media:${match[1]}`;
}

function mediaIDFromStorageKey(storageKey: string) {
    const versioned = /^media:(.+):v1:(?:original|thumbnail)$/.exec(storageKey);
    if (versioned) return versioned[1];
    if (storageKey.startsWith("media:")) return storageKey.slice("media:".length);
    if (storageKey.startsWith("preview:")) return storageKey.slice("preview:".length);
    return undefined;
}

export function mediaIdFromImageStorageKey(storageKey?: string) {
    return storageKey ? mediaIDFromStorageKey(storageKey) : undefined;
}

function canonicalStorageKey(storageKey: string) {
    const mediaId = mediaIDFromStorageKey(storageKey);
    if (!mediaId) return storageKey;
    return storageKey.startsWith("preview:") || storageKey.endsWith(":thumbnail") ? imageThumbnailStorageKey(mediaId) : imageStorageKeyForMedia(mediaId);
}

function expandExplicitDeletionKeys(keys: Iterable<string>) {
    const expanded = new Set<string>();
    for (const key of keys) {
        expanded.add(key);
        const mediaId = mediaIDFromStorageKey(key);
        if (mediaId) {
            expanded.add(imageStorageKeyForMedia(mediaId));
            expanded.add(imageThumbnailStorageKey(mediaId));
            expanded.add(`media:${mediaId}`);
            expanded.add(`preview:${mediaId}`);
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

function imageFetchStatus(error: unknown) {
    if (!error || typeof error !== "object" || !("status" in error)) return undefined;
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
}

function isImageFetchAbort(error: unknown, signal?: AbortSignal) {
    return Boolean(signal?.aborted || (error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError"));
}

function throwIfImageLoadAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw Object.assign(new Error("图片加载已取消"), { name: "AbortError" });
}

export function createImageStorageOperations(options: ImageStorageOperationsOptions) {
    const fetchImageBlob = options.fetchImageBlob || (async (url: string, loadOptions?: MediaLoadOptions) => imageBlobFromResponse(await fetch(appApiPath(url), { signal: loadOptions?.signal })));
    const createPreviewBlob = options.createPreviewBlob || createImagePreview;
    const createObjectURL = options.createObjectURL || ((blob: Blob) => URL.createObjectURL(blob));
    const revokeObjectURL = options.revokeObjectURL || ((url: string) => URL.revokeObjectURL(url));
    const readMeta = options.readMeta || readImageMeta;
    const now = options.now || Date.now;
    const cacheIndexStore = options.cacheIndexStore || options.store;
    const cacheBudgetBytes = options.cacheBudgetBytes ?? DEFAULT_CACHE_BUDGET_BYTES;
    const cacheHighWatermarkBytes = Math.min(options.cacheHighWatermarkBytes ?? DEFAULT_CACHE_HIGH_WATERMARK_BYTES, cacheBudgetBytes);
    const cacheLowWatermarkBytes = Math.min(options.cacheLowWatermarkBytes ?? DEFAULT_CACHE_LOW_WATERMARK_BYTES, cacheHighWatermarkBytes);
    const cacheMaxEntries = Math.max(1, options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES);
    const cacheHighWatermarkEntries = Math.min(Math.max(1, options.cacheHighWatermarkEntries ?? DEFAULT_CACHE_HIGH_WATERMARK_ENTRIES), cacheMaxEntries);
    const cacheLowWatermarkEntries = Math.min(Math.max(0, options.cacheLowWatermarkEntries ?? DEFAULT_CACHE_LOW_WATERMARK_ENTRIES), cacheHighWatermarkEntries);
    const cacheBudgetScheduleKey = `${options.scope}@${options.scopeVersion}`;

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

    const writeCacheMetadata = async (storageKey: string, blob: Blob, generation: number) =>
        withStorageMutations([CACHE_TOTAL_KEY, cacheMetadataKey(storageKey)], async () => {
            ensureActive(options);
            ensureGeneration(storageKey, generation);
            const metadataKey = cacheMetadataKey(storageKey);
            const previous = normalizeCacheMetadata(await cacheIndexStore.getItem<LegacyCacheMetadata>(metadataKey));
            const total = await cacheIndexStore.getItem<CacheTotal>(CACHE_TOTAL_KEY);
            const bytes = Math.max(0, blob.size);
            const timestamp = now();
            await cacheIndexStore.setItem<CacheMetadata>(metadataKey, { bytes, cachedAt: previous?.cachedAt || timestamp, lastAccessedAt: timestamp, variant: cacheVariant(storageKey) });
            await cacheIndexStore.setItem<CacheTotal>(CACHE_TOTAL_KEY, {
                bytes: Math.max(0, (total?.bytes || 0) - Math.max(0, previous?.bytes || 0) + bytes),
                entries: Math.max(0, (total?.entries || 0) - (previous ? 1 : 0) + 1),
            });
            ensureActive(options);
            ensureGeneration(storageKey, generation);
        });
    const deleteCacheMetadata = async (storageKey: string) =>
        withStorageMutations([CACHE_TOTAL_KEY, cacheMetadataKey(storageKey)], async () => {
            const metadataKey = cacheMetadataKey(storageKey);
            const previous = normalizeCacheMetadata(await cacheIndexStore.getItem<LegacyCacheMetadata>(metadataKey));
            const total = await cacheIndexStore.getItem<CacheTotal>(CACHE_TOTAL_KEY);
            await cacheIndexStore.removeItem(metadataKey);
            await cacheIndexStore.setItem<CacheTotal>(CACHE_TOTAL_KEY, {
                bytes: Math.max(0, (total?.bytes || 0) - Math.max(0, previous?.bytes || 0)),
                entries: Math.max(0, (total?.entries || 0) - (previous ? 1 : 0)),
            });
        });
    const touchCacheMetadataWithoutBlockingDisplay = async (storageKey: string, blob: Blob, generation: number) => {
        try {
            await writeCacheMetadata(storageKey, blob, generation);
        } catch (error) {
            if (options.isActive() && currentGeneration(storageKey) === generation) console.warn("更新图片缓存元数据失败", error instanceof Error ? error.message : String(error));
        }
    };
    const touchCachedMetadataWithoutBlockingDisplay = async (storageKey: string, generation: number) => {
        try {
            await withStorageMutation(cacheMetadataKey(storageKey), async () => {
                ensureActive(options);
                ensureGeneration(storageKey, generation);
                const metadataKey = cacheMetadataKey(storageKey);
                const metadata = normalizeCacheMetadata(await cacheIndexStore.getItem<LegacyCacheMetadata>(metadataKey));
                if (!metadata) return;
                await cacheIndexStore.setItem<CacheMetadata>(metadataKey, { ...metadata, lastAccessedAt: now() });
            });
        } catch (error) {
            if (options.isActive() && currentGeneration(storageKey) === generation) console.warn("更新图片缓存元数据失败", error instanceof Error ? error.message : String(error));
        }
    };
    async function migrateLegacyBlob(storageKey: string, generation: number) {
        const legacyKey = legacyStorageKey(storageKey);
        if (!legacyKey) return undefined;
        return withStorageMutations([storageKey, legacyKey], async () => {
            ensureActive(options);
            ensureGeneration(storageKey, generation);
            const current = await options.store.getItem<Blob>(storageKey);
            if (current) return current;
            const legacy = await options.store.getItem<Blob>(legacyKey);
            if (!legacy) return undefined;
            await writeBlobUnlocked(storageKey, legacy, generation);
            const legacyURL = options.objectUrls.get(legacyKey);
            if (legacyURL) {
                options.objectUrls.delete(legacyKey);
                options.objectUrls.set(storageKey, legacyURL);
            }
            await options.store.removeItem(legacyKey);
            await deleteCacheMetadata(legacyKey);
            invalidateKey(legacyKey);
            bumpWriteRevision(legacyKey);
            return legacy;
        });
    }
    const readBlob = async (storageKey: string, generation = currentGeneration(storageKey)) => {
        const blob = (await options.store.getItem<Blob>(storageKey)) || (await migrateLegacyBlob(storageKey, generation));
        ensureActive(options);
        ensureGeneration(storageKey, generation);
        if (blob) void touchCacheMetadataWithoutBlockingDisplay(storageKey, blob, generation);
        ensureActive(options);
        return blob || undefined;
    };
    const clearInvalidatedWrite = async (storageKey: string) => {
        const url = options.objectUrls.get(storageKey);
        if (url) revokeObjectURL(url);
        options.objectUrls.delete(storageKey);
        await options.store.removeItem(storageKey);
        await deleteCacheMetadata(storageKey);
        bumpWriteRevision(storageKey);
    };
    const writeBlobUnlocked = async (storageKey: string, blob: Blob, generation: number) => {
        ensureActive(options);
        ensureGeneration(storageKey, generation);
        await options.store.setItem(storageKey, blob);
        try {
            ensureActive(options);
            ensureGeneration(storageKey, generation);
            await writeCacheMetadata(storageKey, blob, generation);
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
        void scheduleCacheBudgetEnforcement();
        ensureActive(options);
        ensureGeneration(storageKey, generation);
        return blob;
    };
    const writeBlob = async (storageKey: string, blob: Blob, generation = currentGeneration(storageKey)) =>
        withStorageMutation(storageKey, () => writeBlobUnlocked(storageKey, blob, generation));
    const fetchRemoteBlob = async (remoteURL: RemoteMediaURL, loadOptions: MediaLoadOptions = {}) => {
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                throwIfImageLoadAborted(loadOptions.signal);
                const url = await resolveRemoteURL(remoteURL);
                throwIfImageLoadAborted(loadOptions.signal);
                return await fetchImageBlob(url, loadOptions);
            } catch (error) {
                lastError = error;
                if (isImageFetchAbort(error, loadOptions.signal)) throw error;
                if (attempt === 0 && imageFetchStatus(error) === 403) continue;
                throw error;
            }
        }
        throw lastError instanceof Error ? lastError : new Error("下载图片失败");
    };
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

    const loadMediaImage = (mediaId: string, remoteURL: RemoteMediaURL, loadOptions: MediaLoadOptions = {}) => {
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
                        const blob = await fetchRemoteBlob(remoteURL, loadOptions);
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

    const loadMediaThumbnail = (mediaId: string, remoteThumbnailURL: RemoteMediaURL, loadOptions: MediaLoadOptions = {}) => {
        const previewKey = imageThumbnailStorageKey(mediaId);
        const originalKey = imageStorageKeyForMedia(mediaId);
        const previewGeneration = currentGeneration(previewKey);
        const originalGeneration = currentGeneration(originalKey);
        return coalesceMediaLoad(`${scopedLoadKey(options, previewKey)}#${previewGeneration}.${originalGeneration}`, async () => {
            const finish = markInFlight([previewKey, originalKey]);
            try {
                const cachedPreview = async () => {
                    const blob = await readBlob(previewKey, previewGeneration);
                    return blob ? { blob, storageKey: previewKey, generation: previewGeneration } : undefined;
                };
                const remotePreview = async () => {
                    const blob = await fetchRemoteBlob(remoteThumbnailURL, loadOptions);
                    ensureActive(options);
                    await writeBlob(previewKey, blob, previewGeneration);
                    return { blob, storageKey: previewKey, generation: previewGeneration };
                };
                if (loadOptions.preferRemoteThumbnail) {
                    const preview = await cachedPreview();
                    if (preview) return await toUploadedImage(preview, mediaId);
                    try {
                        return await toUploadedImage(await remotePreview(), mediaId);
                    } catch (remoteError) {
                        if (isImageFetchAbort(remoteError, loadOptions.signal)) throw remoteError;
                        const original = await readBlob(originalKey, originalGeneration);
                        if (!original) throw remoteError;
                        try {
                            const blob = await createPreviewBlob(original);
                            await writeBlob(previewKey, blob, previewGeneration);
                            return await toUploadedImage({ blob, storageKey: previewKey, generation: previewGeneration }, mediaId);
                        } catch {
                            return await toUploadedImage({ blob: original, storageKey: originalKey, generation: originalGeneration }, mediaId);
                        }
                    }
                }
                const variant = await resolvePreview<CachedVariant>({
                    readPreview: cachedPreview,
                    readOriginal: async () => {
                        const blob = await readBlob(originalKey, originalGeneration);
                        return blob ? { blob, storageKey: originalKey, generation: originalGeneration } : undefined;
                    },
                    createPreview: async (original) => {
                        const blob = await createPreviewBlob(original.blob);
                        await writeBlob(previewKey, blob, previewGeneration);
                        return { blob, storageKey: previewKey, generation: previewGeneration };
                    },
                    loadRemotePreview: remotePreview,
                });
                return await toUploadedImage(variant, mediaId);
            } finally {
                finish();
                scheduleCacheBudgetEnforcement();
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
            void touchCachedMetadataWithoutBlockingDisplay(storageKey, currentGeneration(storageKey));
            return cached;
        }
        const blob = await readBlob(storageKey);
        return blob ? resolveBlobURL(storageKey, blob) : fallback;
    };
    const releaseObjectURL = (storageKey: string) => {
        const url = options.objectUrls.get(storageKey);
        if (!url) return;
        options.objectUrls.delete(storageKey);
        revokeObjectURL(url);
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
                await deleteCacheMetadata(image.storageKey);
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
        bumpWriteRevision(key);
        await deleteCacheMetadata(key);
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
            invalidateKey(key);
        });
        await deleteExactKeys(expanded);
    };

    const enforceCacheBudget = async () => {
        const entries: Array<{ storageKey: string; metadata: CacheMetadata; revision: number }> = [];
        ensureActive(options);
        await cacheIndexStore.iterate<unknown, void>((value, key) => {
            if (!key.startsWith(CACHE_METADATA_PREFIX) || !value || typeof value !== "object") return;
            const metadata = normalizeCacheMetadata(value as LegacyCacheMetadata);
            if (!metadata) return;
            const storageKey = key.slice(CACHE_METADATA_PREFIX.length);
            entries.push({ storageKey, metadata, revision: currentWriteRevision(storageKey) });
        });
        ensureActive(options);
        let totalBytes = entries.reduce((total, entry) => total + Math.max(0, entry.metadata.bytes), 0);
        let totalEntries = entries.length;
        if (totalBytes <= cacheHighWatermarkBytes && totalEntries <= cacheHighWatermarkEntries) return;

        const candidates = entries
            .filter((entry) => entry.metadata.variant !== "temporary" && !options.objectUrls.has(entry.storageKey) && !isInFlight(entry.storageKey))
            .sort((left, right) => left.metadata.lastAccessedAt - right.metadata.lastAccessedAt);
        const evicted = new Map<string, number>();
        for (const entry of candidates) {
            if (totalBytes <= cacheLowWatermarkBytes && totalEntries <= cacheLowWatermarkEntries) break;
            if (options.objectUrls.has(entry.storageKey) || isInFlight(entry.storageKey)) continue;
            totalBytes -= Math.max(0, entry.metadata.bytes);
            totalEntries -= 1;
            evicted.set(entry.storageKey, entry.revision);
        }
        await deleteExactKeys(
            evicted.keys(),
            (storageKey) => options.isActive() && !options.objectUrls.has(storageKey) && !isInFlight(storageKey) && currentWriteRevision(storageKey) === evicted.get(storageKey),
        );
    };
    const scheduleCacheBudgetEnforcement = () => {
        if (cacheBudgetEnforcementSchedules.has(cacheBudgetScheduleKey)) return;
        cacheBudgetEnforcementSchedules.add(cacheBudgetScheduleKey);
        const run = () => {
            cacheBudgetEnforcementSchedules.delete(cacheBudgetScheduleKey);
            void enforceCacheBudget().catch((error) => {
                console.warn("清理图片缓存失败", error instanceof Error ? error.message : String(error));
            });
        };
        if (typeof requestIdleCallback === "function") requestIdleCallback(run);
        else setTimeout(run, 0);
    };

    const cleanupUnusedImages = async (usedData: unknown) => {
        const usedKeys = collectImageStorageKeys(usedData);
        const unusedOriginals: Array<{ storageKey: string; revision: number }> = [];
        await options.store.iterate<unknown, void>((value, key) => {
            if (key === CACHE_TOTAL_KEY || key.startsWith(CACHE_METADATA_PREFIX) || key.endsWith(":thumbnail") || key.startsWith("preview:")) return;
            if (!usedKeys.has(key) && !isInFlight(key)) unusedOriginals.push({ storageKey: key, revision: currentWriteRevision(key) });
        });
        const unusedOriginalRevisions = new Map(unusedOriginals.map(({ storageKey, revision }) => [storageKey, revision]));
        await deleteExactKeys(
            unusedOriginalRevisions.keys(),
            (storageKey) => !isInFlight(storageKey) && currentWriteRevision(storageKey) === unusedOriginalRevisions.get(storageKey),
        );
        await enforceCacheBudget();
    };

    return { loadMediaImage, loadMediaThumbnail, storeImage, resolveImageUrl, releaseObjectURL, getImageBlob, setImageBlob, promoteImageStorageKey, deleteStoredImages, cleanupUnusedImages, enforceCacheBudget };
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

export async function loadMediaImage(mediaId: string, remoteURL: RemoteMediaURL, loadOptions?: MediaLoadOptions): Promise<UploadedImage> {
    return currentOperations().loadMediaImage(mediaId, remoteURL, loadOptions);
}

export async function loadMediaThumbnail(mediaId: string, remoteThumbnailURL: RemoteMediaURL, loadOptions?: MediaLoadOptions): Promise<UploadedImage> {
    return currentOperations().loadMediaThumbnail(mediaId, remoteThumbnailURL, loadOptions);
}

export async function promoteImageStorageKey(image: UploadedImage, mediaId: string): Promise<UploadedImage> {
    return currentOperations().promoteImageStorageKey(image, mediaId);
}

export type RemoteImageAccess = { url: string; previewUrl?: string };

export async function getRemoteImageAccess(mediaId: string): Promise<RemoteImageAccess> {
    const response = await fetch(appApiPath(`/api/v1/media/${encodeURIComponent(mediaId)}/access`), { cache: "no-store" });
    const payload = (await response.json()) as { code: number; data?: RemoteImageAccess; msg?: string };
    if (!response.ok || payload.code !== 0 || !payload.data?.url) throw new Error(payload.msg || "获取图片访问地址失败");
    return payload.data;
}

export async function resolveRemoteImage(mediaId: string) {
    return (await getRemoteImageAccess(mediaId)).url;
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    return currentOperations().resolveImageUrl(storageKey ? canonicalStorageKey(storageKey) : undefined, fallback);
}

export function releaseImageObjectURL(storageKey: string) {
    return currentOperations().releaseObjectURL(canonicalStorageKey(storageKey));
}

export async function getImageBlob(storageKey: string) {
    return currentOperations().getImageBlob(canonicalStorageKey(storageKey));
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    return currentOperations().setImageBlob(storageKey, blob);
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const cachedBlob = image.storageKey ? await getImageBlob(image.storageKey) : null;
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

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string") {
        const storageKey = value.storageKey;
        if (storageKey.startsWith("image:")) keys.add(storageKey);
        const mediaId = mediaIDFromStorageKey(storageKey);
        if (mediaId) {
            keys.add(imageStorageKeyForMedia(mediaId));
            keys.add(imageThumbnailStorageKey(mediaId));
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
