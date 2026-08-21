"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Empty, Pagination } from "antd";
import { RefreshCw, X } from "lucide-react";

import { clipboardImageFile } from "@/lib/clipboard-image";
import { uploadUserImage } from "@/services/api/image";
import { getImageBlob, getRemoteImageAccess, imagePreviewStorageKey, promoteImageStorageKey, resolveImageUrl, uploadImage, uploadImagePreview, type UploadedImage } from "@/services/image-storage";
import { type ImageAsset, useAssetStore } from "@/stores/use-asset-store";
import { PRIVATE_IMAGE_DRAG_TYPE, type PrivateImageDropPayload } from "./material-image-drag";
import { MaterialDrawerToolbar } from "./material-drawer-toolbar";

export function MyAssetsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const drawerPointerInsideRef = useRef(false);
    const [isUploading, setIsUploading] = useState(false);
    const uploadStoredImage = useCallback(
        async (assetId: string, image: UploadedImage, file: File) => {
            const remote = await uploadUserImage(file);
            const persisted = await promoteImageStorageKey(image, remote.mediaId);
            updateAsset(assetId, {
                coverUrl: persisted.url,
                data: { dataUrl: persisted.url, storageKey: persisted.storageKey, width: persisted.width, height: persisted.height, bytes: persisted.bytes, mimeType: persisted.mimeType },
                metadata: { mediaId: remote.mediaId, uploadState: "uploaded" },
            });
        },
        [updateAsset],
    );
    const saveImage = useCallback(
        async (file: File, source: string) => {
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
                    data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType },
                    metadata: { uploadState: "pending" },
                });
                await uploadStoredImage(assetId, image, file);
                message.success("图片已加入我的素材");
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
                await uploadStoredImage(asset.id, { url: asset.coverUrl || asset.data.dataUrl, storageKey: asset.data.storageKey, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType }, file);
                message.success("图片上传成功");
            } catch (error) {
                updateAsset(asset.id, { metadata: { uploadState: "failed", uploadError: uploadErrorMessage(error) } });
                message.error(error instanceof Error ? error.message : "图片上传失败");
            } finally {
                setIsUploading(false);
            }
        },
        [isUploading, message, updateAsset, uploadStoredImage],
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
            void saveImage(file, "剪贴板");
        };
        window.addEventListener("keydown", handlePasteKeyDown, true);
        window.addEventListener("paste", handlePaste, true);
        return () => {
            window.removeEventListener("keydown", handlePasteKeyDown, true);
            window.removeEventListener("paste", handlePaste, true);
        };
    }, [open, saveImage]);

    const selectImage = (file?: File) => {
        if (!file) return;
        void saveImage(file, "本地上传").finally(() => {
            if (fileInputRef.current) fileInputRef.current.value = "";
        });
    };

    if (!open) return null;
    return (
        <aside
            className="fixed bottom-0 left-0 top-16 z-[90] flex w-[min(26rem,calc(100vw-2rem))] flex-col border-r border-stone-200 bg-background/95 shadow-2xl backdrop-blur-xl dark:border-stone-800"
            data-canvas-no-zoom
            onPointerEnter={() => {
                drawerPointerInsideRef.current = true;
            }}
            onPointerLeave={() => {
                drawerPointerInsideRef.current = false;
            }}
        >
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-stone-200 px-4 dark:border-stone-800">
                <h2 className="text-base font-medium">我的素材</h2>
                <button
                    type="button"
                    className="inline-flex size-8 items-center justify-center rounded-md text-stone-500 transition hover:bg-stone-100 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
                    onClick={onClose}
                    aria-label="关闭我的素材"
                >
                    <X className="size-4" />
                </button>
            </div>
            <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
                <MyAssetsTab isUploading={isUploading} onAddImage={() => fileInputRef.current?.click()} onRetryImage={retryImage} />
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => selectImage(event.target.files?.[0])} />
        </aside>
    );
}

function imageTitle(filename: string) {
    return filename.replace(/\.[^.]+$/, "") || "剪贴板图片";
}

function isEditableTarget(target: EventTarget | null) {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}

function uploadErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "上传图片失败";
}

const PAGE_SIZE = 8;

function PickerCard({ asset, onRetry }: { asset: ImageAsset; onRetry: (asset: ImageAsset) => void }) {
    const cover = asset.coverUrl || asset.data.dataUrl;
    const uploadState = asset.metadata?.uploadState;
    const failed = uploadState === "failed";
    const mediaId = typeof asset.metadata?.mediaId === "string" ? asset.metadata.mediaId : "";
    const [previewURL, setPreviewURL] = useState(cover);

    useEffect(() => {
        let cancelled = false;
        if (!mediaId || uploadState === "pending" || failed) {
            setPreviewURL(cover);
            return () => {
                cancelled = true;
            };
        }
        void (async () => {
            const cached = await resolveImageUrl(imagePreviewStorageKey(mediaId), "");
            if (cached) return cached;
            const access = await getRemoteImageAccess(mediaId);
            return (await uploadImagePreview(access.previewUrl || access.url, mediaId)).url;
        })()
            .then((url) => {
                if (!cancelled) setPreviewURL(url || cover);
            })
            .catch(() => {
                if (!cancelled) setPreviewURL(cover);
            });
        return () => {
            cancelled = true;
        };
    }, [cover, failed, mediaId, uploadState]);

    return (
        <div
            draggable={Boolean(previewURL || cover)}
            className="group relative cursor-grab overflow-hidden rounded-lg border border-stone-200 bg-white active:cursor-grabbing dark:border-stone-700 dark:bg-stone-900"
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData(PRIVATE_IMAGE_DRAG_TYPE, JSON.stringify({ assetId: asset.id } satisfies PrivateImageDropPayload));
            }}
            title="拖入画布使用"
        >
            {previewURL || cover ? <img src={previewURL || cover} alt="" className="aspect-[4/3] w-full object-cover" /> : <div className="aspect-[4/3] bg-stone-100 dark:bg-stone-800" />}
            {uploadState === "pending" ? <div className="absolute inset-0 animate-pulse bg-black/15" aria-label="图片上传中" /> : null}
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

function MyAssetsTab({ isUploading, onAddImage, onRetryImage }: { isUploading: boolean; onAddImage: () => void; onRetryImage: (asset: ImageAsset) => void }) {
    const assets = useAssetStore((state) => state.assets);
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((asset) => asset.kind === "image")
            .filter((asset) => !query || [asset.title, ...(asset.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword]);

    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length]);

    return (
        <div className="space-y-4">
            <MaterialDrawerToolbar
                keyword={keyword}
                placeholder="搜索素材"
                onKeywordChange={(value) => {
                    setPage(1);
                    setKeyword(value);
                }}
                onAddImage={onAddImage}
                isUploading={isUploading}
            />

            {visible.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {visible.map((asset) => (
                        <PickerCard key={asset.id} asset={asset} onRetry={onRetryImage} />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有素材" className="py-12" />
            )}

            {filtered.length > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
        </div>
    );
}
