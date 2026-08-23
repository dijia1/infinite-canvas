"use client";

import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { portalStorageScope } from "@/lib/portal-storage-scope";
import { cleanupUnusedImages } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";
import { hydrateStoredAssets } from "./asset-storage-hydration";
import { resolveImageUrl, resolveRemoteImage, uploadImage } from "@/services/image-storage";

export type AssetKind = "text" | "image" | "video";
export type PrivateAssetFolder = {
    id: string;
    name: string;
    parentId?: string;
    createdAt: string;
    updatedAt: string;
};
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    folderId?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    assets: Asset[];
    folders: PrivateAssetFolder[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    createFolder: (name: string, parentId?: string) => string;
    renameFolder: (id: string, name: string) => void;
    removeFolder: (id: string) => void;
    moveAsset: (id: string, folderId?: string) => void;
    renameImageAsset: (id: string, title: string) => void;
    removeAsset: (id: string) => void;
    cleanupImages: (extra?: unknown) => void;
    hydrate: (uid?: string) => Promise<void>;
};

const ASSET_STORE_KEY = "infinite-canvas:asset_store";

function normalizeName(value: string, label: string) {
    const name = value.trim();
    if (name.length < 1 || name.length > 64) throw new Error(`${label}必须为 1–64 个字符`);
    return name;
}

function normalizeFolderId(folderId?: string) {
    const normalized = folderId?.trim();
    return normalized || undefined;
}

function assertFolderExists(folders: PrivateAssetFolder[], folderId?: string) {
    if (folderId && !folders.some((folder) => folder.id === folderId)) throw new Error("目标文件夹不存在");
}

function parseStoredFolders(value: unknown): PrivateAssetFolder[] {
    if (!Array.isArray(value)) return [];
    const folders = value.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const candidate = item as Partial<PrivateAssetFolder>;
        if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return [];
        const name = candidate.name.trim();
        if (!name || name.length > 64) return [];
        return [
            {
                id: candidate.id,
                name,
                parentId: typeof candidate.parentId === "string" && candidate.parentId.trim() ? candidate.parentId.trim() : undefined,
                createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : "",
                updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
            },
        ];
    });
    const folderIds = new Set(folders.map((folder) => folder.id));
    return folders.map((folder) => ({ ...folder, parentId: folder.parentId && folderIds.has(folder.parentId) ? folder.parentId : undefined }));
}

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        try {
            const parsed = JSON.parse(value) as StorageValue<AssetStore>;
            if (!parsed?.state || !Array.isArray(parsed.state.assets)) return null;
            parsed.state.folders = parseStoredFolders((parsed.state as { folders?: unknown }).folders);
            const assets = parsed.state.assets.filter((asset): asset is Asset => Boolean(asset) && typeof asset === "object" && "kind" in asset);
            const hydratedImages = await hydrateStoredAssets(assets, { resolveImageUrl, resolveRemoteImage, uploadImage });
            parsed.state.assets = await Promise.all(
                hydratedImages.map(async (asset) => {
                    if (asset.kind !== "video" || !asset.data.storageKey) return asset;
                    try {
                        return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
                    } catch {
                        return asset;
                    }
                }),
            );
            return parsed;
        } catch {
            return null;
        }
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            assets: [],
            folders: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const folderId = normalizeFolderId(asset.folderId);
                set((state) => {
                    assertFolderExists(state.folders, folderId);
                    return { assets: [{ ...asset, folderId, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] };
                });
                return id;
            },
            updateAsset: (id, patch) => {
                const hasFolderId = Object.prototype.hasOwnProperty.call(patch, "folderId");
                const folderId = hasFolderId ? normalizeFolderId(patch.folderId) : undefined;
                set((state) => {
                    if (hasFolderId) assertFolderExists(state.folders, folderId);
                    const nextPatch = hasFolderId ? { ...patch, folderId } : patch;
                    return {
                        assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...nextPatch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                    };
                });
            },
            createFolder: (value, parentId) => {
                const name = normalizeName(value, "文件夹名称");
                const normalizedParentId = normalizeFolderId(parentId);
                const id = nanoid();
                const now = new Date().toISOString();
                set((state) => {
                    assertFolderExists(state.folders, normalizedParentId);
                    if (state.folders.some((folder) => folder.name === name && folder.parentId === normalizedParentId)) {
                        throw new Error("同级文件夹名称已存在");
                    }
                    return { folders: [...state.folders, { id, name, parentId: normalizedParentId, createdAt: now, updatedAt: now }] };
                });
                return id;
            },
            renameFolder: (id, value) => {
                const name = normalizeName(value, "文件夹名称");
                set((state) => {
                    const folder = state.folders.find((item) => item.id === id);
                    if (!folder) throw new Error("文件夹不存在");
                    if (state.folders.some((item) => item.id !== id && item.name === name && item.parentId === folder.parentId)) {
                        throw new Error("同级文件夹名称已存在");
                    }
                    return { folders: state.folders.map((item) => (item.id === id ? { ...item, name, updatedAt: new Date().toISOString() } : item)) };
                });
            },
            removeFolder: (id) =>
                set((state) => {
                    if (!state.folders.some((folder) => folder.id === id)) throw new Error("文件夹不存在");
                    if (state.folders.some((folder) => folder.parentId === id) || state.assets.some((asset) => asset.kind === "image" && asset.folderId === id)) {
                        throw new Error("文件夹包含图片或子文件夹，请先整理内容");
                    }
                    return { folders: state.folders.filter((folder) => folder.id !== id) };
                }),
            moveAsset: (id, folderId) => {
                const normalizedFolderId = normalizeFolderId(folderId);
                set((state) => {
                    assertFolderExists(state.folders, normalizedFolderId);
                    const asset = state.assets.find((item) => item.id === id);
                    if (!asset) throw new Error("素材不存在");
                    if (asset.kind !== "image") throw new Error("仅图片素材可以移动");
                    return {
                        assets: state.assets.map((item) => (item.id === id ? ({ ...item, folderId: normalizedFolderId, updatedAt: new Date().toISOString() } as Asset) : item)),
                    };
                });
            },
            renameImageAsset: (id, value) => {
                const title = normalizeName(value, "图片名称");
                set((state) => {
                    const asset = state.assets.find((item) => item.id === id);
                    if (!asset) throw new Error("素材不存在");
                    if (asset.kind !== "image") throw new Error("仅图片素材可以重命名");
                    return {
                        assets: state.assets.map((item) => (item.id === id ? ({ ...item, title, updatedAt: new Date().toISOString() } as Asset) : item)),
                    };
                });
            },
            removeAsset: (id) =>
                set((state) => {
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    get().cleanupImages({ assets });
                    return { assets };
                }),
            cleanupImages: (extra) => {
                window.setTimeout(async () => {
                    const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
                    await cleanupUnusedImages({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                    await cleanupUnusedMedia({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                }, 0);
            },
            hydrate: async (uid) => {
                useAssetStore.persist.setOptions({ name: `${ASSET_STORE_KEY}:${portalStorageScope(uid)}` });
                await useAssetStore.persist.rehydrate();
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            skipHydration: true,
            partialize: (state) => ({ assets: state.assets, folders: state.folders }) as StorageValue<AssetStore>["state"],
            merge: (persistedState, currentState) => {
                const assets = Array.isArray((persistedState as { assets?: unknown } | undefined)?.assets) ? (persistedState as { assets: Asset[] }).assets : [];
                const folders = parseStoredFolders((persistedState as { folders?: unknown } | undefined)?.folders);
                return { ...currentState, assets, folders };
            },
        },
    ),
);
