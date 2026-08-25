"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Empty, Input, Modal, Pagination, Spin } from "antd";
import { ImageOff } from "lucide-react";

import { clipboardImageFile } from "@/lib/clipboard-image";
import { isEditableTarget } from "@/lib/editable-target";
import {
    createAdminPublicImageFolder,
    deleteAdminPublicImage,
    deleteAdminPublicImageFolder,
    fetchPublicImageAccess,
    fetchPublicImageFolders,
    fetchPublicImages,
    updateAdminPublicImage,
    updateAdminPublicImageFolder,
    uploadAdminPublicImage,
    type PublicImage,
} from "@/services/api/public-images";
import { fetchPortalSession } from "@/services/api/session";
import { loadMediaImage, loadMediaThumbnail } from "@/services/image-storage";
import { MaterialDrawer } from "./material-drawer";
import { MaterialDrawerToolbar, MaterialThumbnailControl } from "./material-drawer-toolbar";
import { DEFAULT_MATERIAL_THUMBNAIL_STAGE, MaterialContextMenu, MaterialFolderBreadcrumbs, MaterialFolderTree, folderPath, materialThumbnailColumns, type MaterialFolder } from "./material-folder-ui";
import { PUBLIC_IMAGE_DRAG_TYPE, readImageDropPayload, type PublicImageDropPayload } from "./material-image-drag";
import { useVisibleMediaPreview } from "./use-visible-media-preview";

const PAGE_SIZE = 24;
type ContextMenu = { x: number; y: number };
type ImageContextMenu = ContextMenu & { image: PublicImage };
type FolderContextMenu = ContextMenu & { folder: MaterialFolder };
type Editor = { kind: "folder" } | { kind: "folderRename"; folder: MaterialFolder } | { kind: "rename"; image: PublicImage } | { kind: "move"; image: PublicImage };

export function PublicImageDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [keyword, setKeyword] = useState("");
    const deferredKeyword = useDeferredValue(keyword);
    const [page, setPage] = useState(1);
    const [preview, setPreview] = useState<{ title: string; url: string }>();
    const [thumbnailStage, setThumbnailStage] = useState(DEFAULT_MATERIAL_THUMBNAIL_STAGE);
    const [currentFolderId, setCurrentFolderId] = useState<string>();
    const [contextMenu, setContextMenu] = useState<ContextMenu>();
    const [folderContextMenu, setFolderContextMenu] = useState<FolderContextMenu>();
    const [imageContextMenu, setImageContextMenu] = useState<ImageContextMenu>();
    const [editor, setEditor] = useState<Editor>();
    const [editorValue, setEditorValue] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const drawerPointerInsideRef = useRef(false);
    const session = useQuery({ queryKey: ["portal-session"], queryFn: fetchPortalSession, enabled: open, retry: false, staleTime: 5 * 60 * 1000 });
    const isAdmin = Boolean(session.data?.isAdmin);
    const foldersQuery = useQuery({ queryKey: ["public-image-folders"], queryFn: fetchPublicImageFolders, enabled: open, retry: false, staleTime: 30 * 1000 });
    const folders = useMemo<MaterialFolder[]>(() => (foldersQuery.data?.items || []).map((folder) => ({ id: folder.id, name: folder.title, parentId: folder.parentId || undefined })), [foldersQuery.data?.items]);
    const query = useQuery({
        queryKey: ["public-images", deferredKeyword, currentFolderId || "", page],
        queryFn: () => fetchPublicImages({ keyword: deferredKeyword, folderId: currentFolderId || "", page, pageSize: PAGE_SIZE }),
        enabled: open,
        retry: false,
    });
    const images = query.data?.items || [];
    const total = query.data?.total || 0;
    const invalidatePublicLibrary = async () => {
        await Promise.all([queryClient.invalidateQueries({ queryKey: ["public-images"] }), queryClient.invalidateQueries({ queryKey: ["public-image-folders"] }), queryClient.invalidateQueries({ queryKey: ["admin-public-images"] })]);
    };
    const upload = useMutation({
        mutationFn: (file: File) => uploadAdminPublicImage(file, file.name, currentFolderId),
        onSuccess: async () => {
            await invalidatePublicLibrary();
            message.success("公共图片已上传");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "仅管理员可以上传公共图片"),
    });
    const remove = useMutation({
        mutationFn: deleteAdminPublicImage,
        onSuccess: async () => {
            await invalidatePublicLibrary();
            message.success("公共图片已永久删除");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "删除公共图片失败"),
    });

    useEffect(() => {
        setPage(1);
    }, [deferredKeyword, currentFolderId]);
    useEffect(() => {
        if (currentFolderId && !folders.some((folder) => folder.id === currentFolderId)) setCurrentFolderId(undefined);
    }, [currentFolderId, folders]);
    useEffect(() => {
        if (!open || !isAdmin) return;
        const handlePasteKeyDown = (event: KeyboardEvent) => {
            if (!drawerPointerInsideRef.current || isEditableTarget(event.target)) return;
            if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "v") event.stopImmediatePropagation();
        };
        const handlePaste = (event: ClipboardEvent) => {
            if (!drawerPointerInsideRef.current || isEditableTarget(event.target)) return;
            const file = clipboardImageFile(event.clipboardData?.items || []);
            if (!file || upload.isPending) return;
            event.preventDefault();
            upload.mutate(file);
        };
        window.addEventListener("keydown", handlePasteKeyDown, true);
        window.addEventListener("paste", handlePaste, true);
        return () => {
            window.removeEventListener("keydown", handlePasteKeyDown, true);
            window.removeEventListener("paste", handlePaste, true);
        };
    }, [isAdmin, open, upload]);

    const submitEditor = async () => {
        if (!editor || !isAdmin) return;
        const value = editorValue.trim();
        if (!value) {
            message.error("名称不能为空");
            return;
        }
        try {
            if (editor.kind === "folder") await createAdminPublicImageFolder(value, currentFolderId);
            else if (editor.kind === "folderRename") await updateAdminPublicImageFolder(editor.folder.id, value);
            else await updateAdminPublicImage(editor.image.id, { title: value });
            await invalidatePublicLibrary();
            setEditor(undefined);
            message.success(editor.kind === "folder" ? "文件夹已创建" : editor.kind === "folderRename" ? "文件夹已重命名" : "图片已重命名");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        }
    };
    const handleFolderDrop = async (folderId: string, event: DragEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        if (!isAdmin) return;
        const payload = readImageDropPayload<PublicImageDropPayload>(event.dataTransfer.getData(PUBLIC_IMAGE_DRAG_TYPE));
        if (!payload?.id) return;
        try {
            await updateAdminPublicImage(payload.id, { folderId });
            await invalidatePublicLibrary();
            message.success("图片已移动");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "移动公共图片失败");
        }
    };
    const movePublicImage = async (image: PublicImage, folderId?: string) => {
        try {
            await updateAdminPublicImage(image.id, { folderId: folderId || "" });
            await invalidatePublicLibrary();
            setEditor(undefined);
            message.success("图片已移动");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "移动公共图片失败");
        }
    };

    return (
        <>
            <MaterialDrawer
                open={open}
                title="公共素材"
                closeLabel="关闭公共素材"
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
                        if (!isAdmin || (event.target as Element).closest("[data-material-card], [data-folder-id]")) return;
                        event.preventDefault();
                        setContextMenu({ x: event.clientX, y: event.clientY });
                    }}
                    onClick={() => {
                        setContextMenu(undefined);
                        setFolderContextMenu(undefined);
                        setImageContextMenu(undefined);
                    }}
                >
                    <div className="space-y-4">
                        <MaterialDrawerToolbar keyword={keyword} placeholder="搜索当前文件夹" onKeywordChange={setKeyword} onAddImage={isAdmin ? () => fileInputRef.current?.click() : undefined} isUploading={upload.isPending} />
                        <MaterialFolderBreadcrumbs folders={folders} currentFolderId={currentFolderId} onNavigate={setCurrentFolderId} />
                        {foldersQuery.isLoading || query.isLoading ? (
                            <div className="flex justify-center py-16">
                                <Spin />
                            </div>
                        ) : (
                            <>
                                <MaterialFolderTree
                                    folders={folders}
                                    currentFolderId={currentFolderId}
                                    onNavigate={setCurrentFolderId}
                                    onDropImage={(folderId, event) => void handleFolderDrop(folderId, event)}
                                    onFolderContextMenu={(folder, event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        if (!isAdmin) return;
                                        setContextMenu(undefined);
                                        setImageContextMenu(undefined);
                                        setFolderContextMenu({ folder, x: event.clientX, y: event.clientY });
                                    }}
                                />
                                {images.length ? (
                                    <div className={`grid gap-3 ${gridColumnClass(thumbnailStage)}`}>
                                        {images.map((image) => (
                                            <PublicImageCard
                                                key={image.id}
                                                image={image}
                                                isAdmin={isAdmin}
                                                onPreview={setPreview}
                                                onImageContextMenu={(event) => {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    setContextMenu(undefined);
                                                    setImageContextMenu({ image, x: event.clientX, y: event.clientY });
                                                }}
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query.isError || foldersQuery.isError ? "读取公共素材失败" : "当前文件夹没有图片"} className="py-12" />
                                )}
                                {total > PAGE_SIZE ? (
                                    <div className="flex justify-center">
                                        <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} onChange={setPage} />
                                    </div>
                                ) : null}
                            </>
                        )}
                    </div>
                </div>
                <MaterialThumbnailControl thumbnailStage={thumbnailStage} onThumbnailStageChange={setThumbnailStage} />
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
                                setEditorValue(imageContextMenu?.image.title || "");
                                if (imageContextMenu) setEditor({ kind: "rename", image: imageContextMenu.image });
                                setImageContextMenu(undefined);
                            }}
                        >
                            重命名
                        </button>
                        <button
                            type="button"
                            className="block w-full px-3 py-2 text-left hover:bg-stone-50 dark:hover:bg-stone-800"
                            onClick={() => {
                                if (imageContextMenu) setEditor({ kind: "move", image: imageContextMenu.image });
                                setImageContextMenu(undefined);
                            }}
                        >
                            移动到文件夹
                        </button>
                        <button
                            type="button"
                            className="block w-full px-3 py-2 text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                            onClick={() => {
                                if (imageContextMenu) remove.mutate(imageContextMenu.image.id);
                                setImageContextMenu(undefined);
                            }}
                        >
                            删除
                        </button>
                    </>
                </MaterialContextMenu>
                {isAdmin ? (
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
                                    const folder = folderContextMenu?.folder;
                                    setFolderContextMenu(undefined);
                                    if (!folder) return;
                                    void (async () => {
                                        try {
                                            await deleteAdminPublicImageFolder(folder.id);
                                            if (currentFolderId === folder.id) setCurrentFolderId(folder.parentId);
                                            await invalidatePublicLibrary();
                                            message.success("文件夹已删除");
                                        } catch (error) {
                                            message.error(error instanceof Error ? error.message : "删除文件夹失败");
                                        }
                                    })();
                                }}
                            >
                                删除文件夹
                            </button>
                        </>
                    </MaterialContextMenu>
                ) : null}
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
                onOk={() => void submitEditor()}
            >
                {editor?.kind === "move" ? (
                    <div className="grid grid-cols-2 gap-2">
                        <button type="button" className="rounded border border-stone-200 px-3 py-2 text-left text-sm hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800" onClick={() => void movePublicImage(editor.image)}>
                            根目录
                        </button>
                        {folders.map((folder) => (
                            <button
                                key={folder.id}
                                type="button"
                                className="rounded border border-stone-200 px-3 py-2 text-left text-sm hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
                                onClick={() => void movePublicImage(editor.image, folder.id)}
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
                        onPressEnter={() => void submitEditor()}
                        placeholder={editor?.kind === "folder" || editor?.kind === "folderRename" ? "文件夹名称" : "图片名称"}
                    />
                )}
            </Modal>
        </>
    );
}

function gridColumnClass(stage: number) {
    const columns = materialThumbnailColumns(stage);
    return columns === 6 ? "grid-cols-6" : columns === 4 ? "grid-cols-4" : columns === 3 ? "grid-cols-3" : "grid-cols-2";
}

function PublicImageCard({ image, isAdmin, onPreview, onImageContextMenu }: { image: PublicImage; isAdmin: boolean; onPreview: (preview: { title: string; url: string }) => void; onImageContextMenu: (event: MouseEvent) => void }) {
    const [loadFailed, setLoadFailed] = useState(false);
    const loadPreview = useCallback(async () => {
        return await loadMediaThumbnail(image.mediaId, async () => {
                const access = await fetchPublicImageAccess(image.id);
                return access.previewUrl || access.url;
            });
    }, [image.id, image.mediaId]);
    const { ref, url, error, loading } = useVisibleMediaPreview({ identity: image.id, enabled: true, load: loadPreview });
    useEffect(() => {
        if (url) setLoadFailed(false);
    }, [url]);
    const previewFailed = loadFailed || Boolean(error);
    return (
        <div
            ref={ref}
            data-material-card
            draggable={Boolean(url) && !previewFailed}
            className={`group relative overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900 ${url && !previewFailed ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`}
            onDragStart={(event) => {
                if (!url || previewFailed) return;
                event.dataTransfer.effectAllowed = "copyMove";
                event.dataTransfer.setData(PUBLIC_IMAGE_DRAG_TYPE, JSON.stringify({ id: image.id, mediaId: image.mediaId, title: image.title } satisfies PublicImageDropPayload));
            }}
            onClick={() => {
                if (!url || previewFailed) return;
                void loadMediaImage(image.mediaId, async () => (await fetchPublicImageAccess(image.id)).url)
                    .then((original) => onPreview({ title: image.title, url: original.url }))
                    .catch(() => onPreview({ title: image.title, url }));
            }}
            onContextMenu={(event: MouseEvent) => {
                event.preventDefault();
                if (isAdmin) onImageContextMenu(event);
            }}
            title={url && !previewFailed ? (isAdmin ? "点击查看，拖入画布使用；右键管理" : "点击查看，拖入画布使用") : previewFailed ? "图片已损坏" : "图片加载中"}
        >
            {previewFailed ? (
                <BrokenImagePlaceholder />
            ) : url ? (
                <img src={url} alt="" className="aspect-[4/3] w-full object-cover" draggable={false} onError={() => setLoadFailed(true)} />
            ) : (
                <div className={`aspect-[4/3] bg-stone-100 dark:bg-stone-800 ${loading ? "animate-pulse" : ""}`} />
            )}
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
