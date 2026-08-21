"use client";

import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Empty, Pagination, Spin } from "antd";
import { X } from "lucide-react";

import { clipboardImageFile } from "@/lib/clipboard-image";
import { fetchPublicImageAccess, fetchPublicImages, uploadAdminPublicImage, type PublicImage } from "@/services/api/public-images";
import { fetchPortalSession } from "@/services/api/session";
import { imagePreviewStorageKey, resolveImageUrl, uploadImagePreview } from "@/services/image-storage";
import { loadPublicImage } from "@/services/public-image-cache";
import { PUBLIC_IMAGE_DRAG_TYPE, type PublicImageDropPayload } from "./material-image-drag";
import { MaterialDrawerToolbar } from "./material-drawer-toolbar";

const PAGE_SIZE = 24;

export function PublicImageDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [keyword, setKeyword] = useState("");
    const deferredKeyword = useDeferredValue(keyword);
    const [page, setPage] = useState(1);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const drawerPointerInsideRef = useRef(false);
    const session = useQuery({ queryKey: ["portal-session"], queryFn: fetchPortalSession, enabled: open, retry: false, staleTime: 5 * 60 * 1000 });
    const isAdmin = Boolean(session.data?.isAdmin);
    const query = useQuery({
        queryKey: ["public-images", deferredKeyword, page],
        queryFn: () => fetchPublicImages({ keyword: deferredKeyword, page, pageSize: PAGE_SIZE }),
        enabled: open,
        retry: false,
    });
    const images = query.data?.items || [];
    const total = query.data?.total || 0;
    const upload = useMutation({
        mutationFn: (file: File) => uploadAdminPublicImage(file, file.name),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["public-images"] });
            await queryClient.invalidateQueries({ queryKey: ["admin-public-images"] });
            message.success("公共图片已上传");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "仅管理员可以上传公共图片"),
    });

    useEffect(() => {
        setPage(1);
    }, [deferredKeyword]);

    useEffect(() => {
        if (!open || !isAdmin) return;
        const handlePasteKeyDown = (event: KeyboardEvent) => {
            if (!drawerPointerInsideRef.current || isEditableTarget(event.target)) return;
            if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "v") event.stopImmediatePropagation();
        };
        const handlePaste = (event: ClipboardEvent) => {
            if (!drawerPointerInsideRef.current || isEditableTarget(event.target)) return;
            const file = clipboardImageFile(event.clipboardData?.items || []);
            if (!file) return;
            event.preventDefault();
            if (upload.isPending) return;
            upload.mutate(file);
        };
        window.addEventListener("keydown", handlePasteKeyDown, true);
        window.addEventListener("paste", handlePaste, true);
        return () => {
            window.removeEventListener("keydown", handlePasteKeyDown, true);
            window.removeEventListener("paste", handlePaste, true);
        };
    }, [isAdmin, open, upload]);

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
                <h2 className="text-base font-medium">公共素材</h2>
                <button
                    type="button"
                    className="inline-flex size-8 items-center justify-center rounded-md text-stone-500 transition hover:bg-stone-100 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
                    onClick={onClose}
                    aria-label="关闭公共素材"
                >
                    <X className="size-4" />
                </button>
            </div>
            <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
                <div className="space-y-4">
                    <MaterialDrawerToolbar
                        keyword={keyword}
                        placeholder="搜索素材"
                        onKeywordChange={setKeyword}
                        onAddImage={isAdmin ? () => fileInputRef.current?.click() : undefined}
                        isUploading={upload.isPending}
                    />
                    {query.isLoading ? (
                        <div className="flex justify-center py-16">
                            <Spin />
                        </div>
                    ) : images.length ? (
                        <div className="grid grid-cols-4 gap-3">
                            {images.map((image) => (
                                <PublicImageCard key={image.id} image={image} />
                            ))}
                        </div>
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query.isError ? "读取公共素材失败" : "暂无公共图片"} className="py-12" />
                    )}
                    {total > PAGE_SIZE ? (
                        <div className="flex justify-center">
                            <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} onChange={setPage} />
                        </div>
                    ) : null}
                </div>
            </div>
            {isAdmin ? (
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file && !upload.isPending) upload.mutate(file);
                        event.target.value = "";
                    }}
                />
            ) : null}
        </aside>
    );
}

function isEditableTarget(target: EventTarget | null) {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}

function PublicImageCard({ image }: { image: PublicImage }) {
    const [url, setURL] = useState("");

    useEffect(() => {
        let cancelled = false;
        void loadPublicImage(image, {
            readCachedImage: resolveImageUrl,
            requestAccess: async (id) => {
                const access = await fetchPublicImageAccess(id);
                return access.previewUrl || access.url;
            },
            cacheImage: async (accessURL, mediaId) => (await uploadImagePreview(accessURL, mediaId)).url,
            storageKey: imagePreviewStorageKey,
        })
            .then((result) => {
                if (!cancelled) setURL(result.url);
            })
            .catch(() => {
                if (!cancelled) setURL("");
            });
        return () => {
            cancelled = true;
        };
    }, [image]);

    return (
        <div
            draggable={Boolean(url)}
            className="group cursor-grab overflow-hidden rounded-lg border border-stone-200 bg-white active:cursor-grabbing dark:border-stone-700 dark:bg-stone-900"
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData(PUBLIC_IMAGE_DRAG_TYPE, JSON.stringify({ id: image.id, mediaId: image.mediaId, title: image.title } satisfies PublicImageDropPayload));
            }}
            title="拖入画布使用"
        >
            {url ? <img src={url} alt="" className="aspect-[4/3] w-full object-cover" draggable={false} /> : <div className="aspect-[4/3] animate-pulse bg-stone-100 dark:bg-stone-800" />}
        </div>
    );
}
