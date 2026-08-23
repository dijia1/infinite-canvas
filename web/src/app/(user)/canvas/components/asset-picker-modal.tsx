"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { App, Empty, Input, Modal, Pagination } from "antd";
import { ImageOff, RefreshCw } from "lucide-react";

import { clipboardImageFile } from "@/lib/clipboard-image";
import { isEditableTarget } from "@/lib/editable-target";
import { deleteUserImage, uploadUserImage } from "@/services/api/image";
import { fetchPublicImageAccess } from "@/services/api/public-images";
import { deleteStoredImages, getImageBlob, getRemoteImageAccess, imagePreviewStorageKey, loadMediaPreview, promoteImageStorageKey, uploadImage, type UploadedImage } from "@/services/image-storage";
import { type Asset, type ImageAsset, type PrivateAssetFolder, useAssetStore } from "@/stores/use-asset-store";
import { MaterialDrawer } from "./material-drawer";
import { MaterialDrawerToolbar, MaterialThumbnailControl } from "./material-drawer-toolbar";
import { DEFAULT_MATERIAL_THUMBNAIL_STAGE, MaterialContextMenu, MaterialFolderBreadcrumbs, MaterialFolderTree, folderPath, materialThumbnailColumns } from "./material-folder-ui";
import { PRIVATE_IMAGE_DRAG_TYPE, readImageDropPayload, type PrivateImageDropPayload } from "./material-image-drag";

const PAGE_SIZE = 24;
type ContextMenu = { x: number; y: number };
type ImageContextMenu = ContextMenu & { asset: ImageAsset };
type FolderContextMenu = ContextMenu & { folder: PrivateAssetFolder };
type Editor = { kind: "folder" } | { kind: "folderRename"; folder: PrivateAssetFolder } | { kind: "rename"; asset: ImageAsset } | { kind: "move"; asset: ImageAsset };

export function MyAssetsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const assets = useAssetStore((state) => state.assets);
    const folders = useAssetStore((state) => state.folders);
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const createFolder = useAssetStore((state) => state.createFolder);
    const renameFolder = useAssetStore((state) => state.renameFolder);
    const removeFolder = useAssetStore((state) => state.removeFolder);
    const moveAsset = useAssetStore((state) => state.moveAsset);
    const renameImageAsset = useAssetStore((state) => state.renameImageAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const drawerPointerInsideRef = useRef(false);
    const [isUploading, setIsUploading] = useState(false);
    const [deletingAssetId, setDeletingAssetId] = useState<string>();
    const [preview, setPreview] = useState<{ title: string; url: string }>();
    const [thumbnailStage, setThumbnailStage] = useState(DEFAULT_MATERIAL_THUMBNAIL_STAGE);
    const [currentFolderId, setCurrentFolderId] = useState<string>();
    const [contextMenu, setContextMenu] = useState<ContextMenu>();
    const [folderContextMenu, setFolderContextMenu] = useState<FolderContextMenu>();
    const [imageContextMenu, setImageContextMenu] = useState<ImageContextMenu>();
    const [editor, setEditor] = useState<Editor>();
    const [editorValue, setEditorValue] = useState("");

    useEffect(() => {
        if (currentFolderId && !folders.some((folder) => folder.id === currentFolderId)) setCurrentFolderId(undefined);
    }, [currentFolderId, folders]);

    const uploadStoredImage = useCallback(
        async (assetId: string, image: UploadedImage, file: File) => {
            const remote = await uploadUserImage(file);
            const assetExists = () => useAssetStore.getState().assets.some((asset) => asset.id === assetId);
            if (!assetExists()) {
                await deleteUserImage(remote.mediaId);
                return false;
            }
            let persisted: UploadedImage;
            try {
                persisted = await promoteImageStorageKey(image, remote.mediaId);
            } catch (error) {
                if (!assetExists()) {
                    await deleteUserImage(remote.mediaId);
                    return false;
                }
                throw error;
            }
            if (!assetExists()) {
                try {
                    await deleteUserImage(remote.mediaId);
                } finally {
                    await deleteStoredImages([persisted.storageKey]);
                }
                return false;
            }
            updateAsset(assetId, {
                coverUrl: persisted.url,
                data: { dataUrl: persisted.url, storageKey: persisted.storageKey, width: persisted.width, height: persisted.height, bytes: persisted.bytes, mimeType: persisted.mimeType },
                metadata: { mediaId: remote.mediaId, uploadState: "uploaded" },
            });
            return true;
        },
        [updateAsset],
    );
    const saveImage = useCallback(
        async (file: File, source: string, folderId?: string) => {
            if (isUploading) return;
            setIsUploading(true);
            let assetId: string | undefined;
            try {
                const image = await uploadImage(file);
                assetId = addAsset({
                    kind: "image",
                    title: imageTitle(file.name),
                    coverUrl: image.url,
                    tags: [],
                    source,
                    folderId,
                    data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType },
                    metadata: { uploadState: "pending" },
                });
                if (await uploadStoredImage(assetId, image, file)) message.success("图片已加入我的素材");
            } catch (error) {
                if (assetId) updateAsset(assetId, { metadata: { uploadState: "failed", uploadError: uploadErrorMessage(error) } });
                message.error(error instanceof Error ? error.message : `${source === "剪贴板" ? "粘贴" : "上传"}图片失败`);
            } finally {
                setIsUploading(false);
            }
        },
        [addAsset, isUploading, message, updateAsset, uploadStoredImage],
    );

    const retryImage = useCallback(
        async (asset: ImageAsset) => {
            if (isUploading || !asset.data.storageKey) return;
            const blob = await getImageBlob(asset.data.storageKey);
            if (!blob) {
                message.error("本地图片缓存不存在，无法重试上传");
                return;
            }
            const file = new File([blob], asset.title || "image.png", { type: asset.data.mimeType || blob.type || "image/png" });
            setIsUploading(true);
            updateAsset(asset.id, { metadata: { uploadState: "pending" } });
            try {
                if (await uploadStoredImage(asset.id, { url: asset.coverUrl || asset.data.dataUrl, storageKey: asset.data.storageKey, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType }, file)) {
                    message.success("图片上传成功");
                }
            } catch (error) {
                updateAsset(asset.id, { metadata: { uploadState: "failed", uploadError: uploadErrorMessage(error) } });
                message.error(error instanceof Error ? error.message : "图片上传失败");
            } finally {
                setIsUploading(false);
            }
        },
        [isUploading, message, updateAsset, uploadStoredImage],
    );

    const deleteImage = useCallback(
        async (asset: ImageAsset) => {
            if (deletingAssetId) return;
            const mediaId = typeof asset.metadata?.mediaId === "string" ? asset.metadata.mediaId : "";
            const publicImageId = typeof asset.metadata?.publicImageId === "string" ? asset.metadata.publicImageId : "";
            setDeletingAssetId(asset.id);
            try {
                if (mediaId && !publicImageId) await deleteUserImage(mediaId);
                removeAsset(asset.id);
                if (!publicImageId) await deleteStoredImages([asset.data.storageKey, ...(mediaId ? [imagePreviewStorageKey(mediaId)] : [])].filter((key): key is string => Boolean(key)));
                message.success("图片已永久删除");
            } catch (error) {
                message.error(error instanceof Error ? `删除图片失败：${error.message}` : "删除图片失败");
            } finally {
                setDeletingAssetId(undefined);
            }
        },
        [deletingAssetId, message, removeAsset],
    );

    useEffect(() => {
        if (!open) return;
        const handlePasteKeyDown = (event: KeyboardEvent) => {
            if (!drawerPointerInsideRef.current || isEditableTarget(event.target)) return;
            if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "v") event.stopImmediatePropagation();
        };
        const handlePaste = (event: ClipboardEvent) => {
            if (!drawerPointerInsideRef.current || isEditableTarget(event.target)) return;
            const file = clipboardImageFile(event.clipboardData?.items || []);
            if (!file) return;
            event.preventDefault();
            void saveImage(file, "剪贴板", currentFolderId);
        };
        window.addEventListener("keydown", handlePasteKeyDown, true);
        window.addEventListener("paste", handlePaste, true);
        return () => {
            window.removeEventListener("keydown", handlePasteKeyDown, true);
            window.removeEventListener("paste", handlePaste, true);
        };
    }, [currentFolderId, open, saveImage]);

    const submitEditor = () => {
        const value = editorValue.trim();
        if (!value) {
            message.error("名称不能为空");
            return;
        }
        try {
            if (editor?.kind === "folder") {
                createFolder(value, currentFolderId);
                message.success("文件夹已创建");
            } else if (editor?.kind === "folderRename") {
                renameFolder(editor.folder.id, value);
                message.success("文件夹已重命名");
            } else if (editor?.kind === "rename") {
                renameImageAsset(editor.asset.id, value);
                message.success("图片已重命名");
            }
            setEditor(undefined);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        }
    };
    const handleFolderDrop = (folderId: string, event: DragEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const payload = readImageDropPayload<PrivateImageDropPayload>(event.dataTransfer.getData(PRIVATE_IMAGE_DRAG_TYPE));
        if (!payload?.assetId) return;
        try {
            moveAsset(payload.assetId, folderId);
            message.success("图片已移动");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "移动图片失败");
        }
    };

    return (
        <>
            <MaterialDrawer
                open={open}
                title="我的素材"
                closeLabel="关闭我的素材"
                onClose={onClose}
                onPointerEnter={() => {
                    drawerPointerInsideRef.current = true;
                }}
                onPointerLeave={() => {
                    drawerPointerInsideRef.current = false;
                }}
            >
                <div
                    className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4"
                    onContextMenu={(event) => {
                        if ((event.target as Element).closest("[data-material-card], [data-folder-id]")) return;
                        event.preventDefault();
                        setContextMenu({ x: event.clientX, y: event.clientY });
                    }}
                    onClick={() => {
                        setContextMenu(undefined);
                        setFolderContextMenu(undefined);
                        setImageContextMenu(undefined);
                    }}
                >
                    <MyAssetsTab
                        assets={assets}
                        folders={folders}
                        currentFolderId={currentFolderId}
                        thumbnailStage={thumbnailStage}
                        isUploading={isUploading}
                        onNavigate={setCurrentFolderId}
                        onAddImage={() => fileInputRef.current?.click()}
                        onRetryImage={retryImage}
                        onPreview={setPreview}
                        onFolderDrop={handleFolderDrop}
                        onImageContextMenu={(asset, event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setContextMenu(undefined);
                            setImageContextMenu({ asset, x: event.clientX, y: event.clientY });
                        }}
                        onFolderContextMenu={(folder, event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setContextMenu(undefined);
                            setImageContextMenu(undefined);
                            setFolderContextMenu({ folder, x: event.clientX, y: event.clientY });
                        }}
                    />
                </div>
                <MaterialThumbnailControl thumbnailStage={thumbnailStage} onThumbnailStageChange={setThumbnailStage} />
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void saveImage(file, "本地上传", currentFolderId);
                        event.target.value = "";
                    }}
                />
                <MaterialContextMenu position={contextMenu}>
                    <button
                        type="button"
                        className="block w-full px-3 py-2 text-left hover:bg-stone-50 dark:hover:bg-stone-800"
                        onClick={() => {
                            setContextMenu(undefined);
                            setEditorValue("");
                            setEditor({ kind: "folder" });
                        }}
                    >
                        新建文件夹
                    </button>
                </MaterialContextMenu>
                <MaterialContextMenu position={imageContextMenu}>
                    <>
                        <button
                            type="button"
                            className="block w-full px-3 py-2 text-left hover:bg-stone-50 dark:hover:bg-stone-800"
                            onClick={() => {
                                setEditorValue(imageContextMenu?.asset.title || "");
                                if (imageContextMenu) setEditor({ kind: "rename", asset: imageContextMenu.asset });
                                setImageContextMenu(undefined);
                            }}
                        >
                            重命名
                        </button>
                        <button
                            type="button"
                            className="block w-full px-3 py-2 text-left hover:bg-stone-50 dark:hover:bg-stone-800"
                            onClick={() => {
                                if (imageContextMenu) setEditor({ kind: "move", asset: imageContextMenu.asset });
                                setImageContextMenu(undefined);
                            }}
                        >
                            移动到文件夹
                        </button>
                        <button
                            type="button"
                            className="block w-full px-3 py-2 text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                            onClick={() => {
                                if (imageContextMenu) void deleteImage(imageContextMenu.asset);
                                setImageContextMenu(undefined);
                            }}
                        >
                            删除
                        </button>
                    </>
                </MaterialContextMenu>
                <MaterialContextMenu position={folderContextMenu}>
                    <>
                        <button
                            type="button"
                            className="block w-full px-3 py-2 text-left hover:bg-stone-50 dark:hover:bg-stone-800"
                            onClick={() => {
                                if (folderContextMenu) {
                                    setEditorValue(folderContextMenu.folder.name);
                                    setEditor({ kind: "folderRename", folder: folderContextMenu.folder });
                                }
                                setFolderContextMenu(undefined);
                            }}
                        >
                            重命名文件夹
                        </button>
                        <button
                            type="button"
                            className="block w-full px-3 py-2 text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                            onClick={() => {
                                if (!folderContextMenu) return;
                                try {
                                    removeFolder(folderContextMenu.folder.id);
                                    if (currentFolderId === folderContextMenu.folder.id) setCurrentFolderId(folderContextMenu.folder.parentId);
                                    message.success("文件夹已删除");
                                } catch (error) {
                                    message.error(error instanceof Error ? error.message : "删除文件夹失败");
                                } finally {
                                    setFolderContextMenu(undefined);
                                }
                            }}
                        >
                            删除文件夹
                        </button>
                    </>
                </MaterialContextMenu>
            </MaterialDrawer>
            <Modal open={Boolean(preview)} title={preview?.title} footer={null} onCancel={() => setPreview(undefined)} width="min(90vw, 72rem)">
                {preview ? <img src={preview.url} alt={preview.title} className="max-h-[75vh] w-full object-contain" /> : null}
            </Modal>
            <Modal
                open={Boolean(editor)}
                title={editor?.kind === "folder" ? "新建文件夹" : editor?.kind === "folderRename" ? "重命名文件夹" : editor?.kind === "move" ? "移动到文件夹" : "重命名图片"}
                okText="保存"
                cancelText="取消"
                footer={editor?.kind === "move" ? null : undefined}
                onCancel={() => setEditor(undefined)}
                onOk={submitEditor}
            >
                {editor?.kind === "move" ? (
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            className="rounded border border-stone-200 px-3 py-2 text-left text-sm hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
                            onClick={() => {
                                moveAsset(editor.asset.id);
                                setEditor(undefined);
                            }}
                        >
                            根目录
                        </button>
                        {folders.map((folder) => (
                            <button
                                key={folder.id}
                                type="button"
                                className="rounded border border-stone-200 px-3 py-2 text-left text-sm hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
                                onClick={() => {
                                    moveAsset(editor.asset.id, folder.id);
                                    setEditor(undefined);
                                }}
                            >
                                {folderPath(folders, folder.id)}
                            </button>
                        ))}
                    </div>
                ) : (
                    <Input
                        autoFocus
                        maxLength={64}
                        value={editorValue}
                        onChange={(event) => setEditorValue(event.target.value)}
                        onPressEnter={submitEditor}
                        placeholder={editor?.kind === "folder" || editor?.kind === "folderRename" ? "文件夹名称" : "图片名称"}
                    />
                )}
            </Modal>
        </>
    );
}

function MyAssetsTab({
    assets,
    folders,
    currentFolderId,
    thumbnailStage,
    isUploading,
    onNavigate,
    onAddImage,
    onRetryImage,
    onPreview,
    onFolderDrop,
    onImageContextMenu,
    onFolderContextMenu,
}: {
    assets: Asset[];
    folders: PrivateAssetFolder[];
    currentFolderId?: string;
    thumbnailStage: number;
    isUploading: boolean;
    onNavigate: (folderId?: string) => void;
    onAddImage: () => void;
    onRetryImage: (asset: ImageAsset) => void;
    onPreview: (preview: { title: string; url: string }) => void;
    onFolderDrop: (folderId: string, event: DragEvent<HTMLButtonElement>) => void;
    onImageContextMenu: (asset: ImageAsset, event: MouseEvent) => void;
    onFolderContextMenu: (folder: PrivateAssetFolder, event: MouseEvent<HTMLButtonElement>) => void;
}) {
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((asset): asset is ImageAsset => asset.kind === "image")
            .filter((asset) => (asset.folderId || undefined) === currentFolderId)
            .filter((asset) => !query || [asset.title, ...(asset.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, currentFolderId, keyword]);
    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);
    useEffect(() => {
        setPage((value) => Math.min(value, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))));
    }, [filtered.length]);
    const gridClass = `grid gap-3 ${gridColumnClass(thumbnailStage)}`;
    return (
        <div className="space-y-4">
            <MaterialDrawerToolbar
                keyword={keyword}
                placeholder="搜索当前文件夹"
                onKeywordChange={(value) => {
                    setPage(1);
                    setKeyword(value);
                }}
                onAddImage={onAddImage}
                isUploading={isUploading}
            />
            <MaterialFolderBreadcrumbs
                folders={folders}
                currentFolderId={currentFolderId}
                onNavigate={(folderId) => {
                    setPage(1);
                    onNavigate(folderId);
                }}
            />
            <MaterialFolderTree
                folders={folders}
                currentFolderId={currentFolderId}
                onNavigate={(folderId) => {
                    setPage(1);
                    onNavigate(folderId);
                }}
                onDropImage={onFolderDrop}
                onFolderContextMenu={onFolderContextMenu}
            />
            {visible.length ? (
                <div className={gridClass}>
                    {visible.map((asset) => (
                        <PickerCard key={asset.id} asset={asset} onRetry={onRetryImage} onPreview={onPreview} onImageContextMenu={onImageContextMenu} />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前文件夹没有图片" className="py-12" />
            )}
            {filtered.length > PAGE_SIZE ? (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            ) : null}
        </div>
    );
}

function gridColumnClass(stage: number) {
    const columns = materialThumbnailColumns(stage);
    return columns === 6 ? "grid-cols-6" : columns === 4 ? "grid-cols-4" : columns === 3 ? "grid-cols-3" : "grid-cols-2";
}
function imageTitle(filename: string) {
    return filename.replace(/\.[^.]+$/, "") || "剪贴板图片";
}
function uploadErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "上传图片失败";
}

function formatMaterialPreviewError(error: unknown) {
    const message = error instanceof Error ? error.message.trim() : "未知错误";
    const safeMessage = message
        .replace(/https?:\/\/\S+/gi, "远端地址")
        .replace(/\s+/g, " ")
        .slice(0, 120);
    return `缩略图加载失败：${safeMessage || "未知错误"}`;
}

function PickerCard({
    asset,
    onRetry,
    onPreview,
    onImageContextMenu,
}: {
    asset: ImageAsset;
    onRetry: (asset: ImageAsset) => void;
    onPreview: (preview: { title: string; url: string }) => void;
    onImageContextMenu: (asset: ImageAsset, event: MouseEvent) => void;
}) {
    const cover = asset.coverUrl || asset.data.dataUrl;
    const uploadState = asset.metadata?.uploadState;
    const failed = uploadState === "failed";
    const mediaId = typeof asset.metadata?.mediaId === "string" ? asset.metadata.mediaId : "";
    const publicImageId = typeof asset.metadata?.publicImageId === "string" ? asset.metadata.publicImageId : "";
    const [previewURL, setPreviewURL] = useState(cover);
    const [loadFailed, setLoadFailed] = useState(false);
    const [previewError, setPreviewError] = useState("");
    useEffect(() => {
        let cancelled = false;
        if (!mediaId || uploadState === "pending" || failed) {
            setPreviewURL(cover);
            setLoadFailed(false);
            setPreviewError("");
            return () => {
                cancelled = true;
            };
        }
        void (async () => {
            return (await loadMediaPreview(mediaId, async () => {
                const access = publicImageId ? await fetchPublicImageAccess(publicImageId) : await getRemoteImageAccess(mediaId);
                return access.previewUrl || access.url;
            })).url;
        })()
            .then((url) => {
                if (!cancelled) {
                    setPreviewURL(url || cover);
                    setLoadFailed(false);
                    setPreviewError("");
                }
            })
            .catch((error) => {
                if (!cancelled) {
                    setPreviewURL(cover);
                    setLoadFailed(!cover);
                    setPreviewError(formatMaterialPreviewError(error));
                }
            });
        return () => {
            cancelled = true;
        };
    }, [cover, failed, mediaId, publicImageId, uploadState]);
    const preview = loadFailed ? "" : previewURL || cover;
    return (
        <div
            data-material-card
            draggable={Boolean(preview)}
            className={`group relative overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900 ${preview ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`}
            onDragStart={(event) => {
                if (!preview) return;
                event.dataTransfer.effectAllowed = "copyMove";
                event.dataTransfer.setData(PRIVATE_IMAGE_DRAG_TYPE, JSON.stringify({ assetId: asset.id } satisfies PrivateImageDropPayload));
            }}
            onClick={() => {
                if (preview) onPreview({ title: asset.title, url: preview });
            }}
            onContextMenu={(event: MouseEvent) => onImageContextMenu(asset, event)}
            title={previewError || (preview ? "点击查看，拖入画布使用；右键管理" : "图片已损坏，可删除")}
        >
            {preview ? <img src={preview} alt="" className="aspect-[4/3] w-full object-cover" onError={() => setLoadFailed(true)} /> : <BrokenImagePlaceholder />}
            {uploadState === "pending" ? <div className="absolute inset-0 animate-pulse bg-black/15" aria-label="图片上传中" /> : null}
            {previewError ? (
                <div className="absolute inset-x-0 bottom-0 truncate bg-amber-100/95 px-1.5 py-1 text-[10px] leading-3 text-amber-950 dark:bg-amber-950/95 dark:text-amber-100" aria-label="缩略图加载失败" title={previewError}>
                    {previewError}
                </div>
            ) : null}
            {failed ? (
                <button
                    type="button"
                    className="absolute right-1 top-1 inline-flex size-7 items-center justify-center rounded-full bg-red-600 text-white shadow transition hover:bg-red-700"
                    onClick={(event) => {
                        event.stopPropagation();
                        onRetry(asset);
                    }}
                    title={typeof asset.metadata?.uploadError === "string" ? asset.metadata.uploadError : "上传失败，点击重试"}
                    aria-label="重新上传图片"
                >
                    <RefreshCw className="size-3.5" />
                </button>
            ) : null}
        </div>
    );
}
function BrokenImagePlaceholder() {
    return (
        <div className="flex aspect-[4/3] flex-col items-center justify-center gap-1 bg-stone-100 text-xs text-stone-500 dark:bg-stone-800 dark:text-stone-400">
            <ImageOff className="size-5" aria-hidden />
            <span>图片已损坏</span>
        </div>
    );
}
