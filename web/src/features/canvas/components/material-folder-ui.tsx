"use client";

import { type DragEvent, type MouseEvent, type ReactNode, useState } from "react";
import { Folder } from "lucide-react";
import { createPortal } from "react-dom";

export type MaterialFolder = {
    id: string;
    name: string;
    parentId?: string;
};

export const MATERIAL_THUMBNAIL_COLUMNS = [6, 4, 3, 2] as const;
export const DEFAULT_MATERIAL_THUMBNAIL_STAGE = 1;

export function materialThumbnailColumns(stage: number) {
    return MATERIAL_THUMBNAIL_COLUMNS[Math.max(0, Math.min(MATERIAL_THUMBNAIL_COLUMNS.length - 1, Math.round(stage)))] || MATERIAL_THUMBNAIL_COLUMNS[DEFAULT_MATERIAL_THUMBNAIL_STAGE];
}

export function materialThumbnailGridClass(stage: number) {
    const columns = materialThumbnailColumns(stage);
    return columns === 6 ? "grid-cols-6" : columns === 4 ? "grid-cols-4" : columns === 3 ? "grid-cols-3" : "grid-cols-2";
}

export function folderChildren<T extends MaterialFolder>(folders: T[], parentId?: string) {
    return folders.filter((folder) => (folder.parentId || undefined) === parentId);
}

export function folderBreadcrumbs<T extends MaterialFolder>(folders: T[], folderId?: string) {
    const byID = new Map(folders.map((folder) => [folder.id, folder]));
    const ancestors: T[] = [];
    const visited = new Set<string>();
    let current = folderId ? byID.get(folderId) : undefined;
    while (current && !visited.has(current.id)) {
        ancestors.unshift(current);
        visited.add(current.id);
        current = current.parentId ? byID.get(current.parentId) : undefined;
    }
    return ancestors;
}

export function folderPath<T extends MaterialFolder>(folders: T[], folderId: string) {
    return folderBreadcrumbs(folders, folderId)
        .map((folder) => folder.name)
        .join(" / ");
}

export function MaterialFolderBreadcrumbs({ folders, currentFolderId, onNavigate }: { folders: MaterialFolder[]; currentFolderId?: string; onNavigate: (folderId?: string) => void }) {
    const breadcrumbs = folderBreadcrumbs(folders, currentFolderId);
    return (
        <nav aria-label="素材文件夹路径" className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
            <button type="button" className="rounded px-1 py-0.5 hover:bg-stone-100 hover:text-stone-950 dark:hover:bg-stone-800 dark:hover:text-stone-100" onClick={() => onNavigate(undefined)}>
                根目录
            </button>
            {breadcrumbs.map((folder) => (
                <span key={folder.id} className="contents">
                    <span aria-hidden>/</span>
                    <button type="button" className="max-w-32 truncate rounded px-1 py-0.5 hover:bg-stone-100 hover:text-stone-950 dark:hover:bg-stone-800 dark:hover:text-stone-100" onClick={() => onNavigate(folder.id)}>
                        {folder.name}
                    </button>
                </span>
            ))}
        </nav>
    );
}

export function MaterialContextMenu({ position, children }: { position?: { x: number; y: number }; children: ReactNode }) {
    if (!position || typeof document === "undefined") return null;
    return createPortal(
        <div className="fixed z-[100] min-w-32 overflow-hidden rounded-md border border-stone-200 bg-white py-1 text-sm shadow-lg dark:border-stone-700 dark:bg-stone-900" style={{ left: position.x, top: position.y }} role="menu">
            {children}
        </div>,
        document.body,
    );
}

export function MaterialFolderTree<T extends MaterialFolder>({
    folders,
    currentFolderId,
    onNavigate,
    onDropImage,
    onFolderContextMenu,
}: {
    folders: T[];
    currentFolderId?: string;
    onNavigate: (folderId?: string) => void;
    onDropImage: (folderId: string, event: DragEvent<HTMLButtonElement>) => void;
    onFolderContextMenu: (folder: T, event: MouseEvent<HTMLButtonElement>) => void;
}) {
    const [expandedFolderIDs, setExpandedFolderIDs] = useState<Set<string>>(() => new Set());

    const toggleFolder = (folder: T, hasChildren: boolean) => {
        onNavigate(folder.id);
        if (!hasChildren) return;
        setExpandedFolderIDs((current) => {
            const next = new Set(current);
            if (next.has(folder.id)) next.delete(folder.id);
            else next.add(folder.id);
            return next;
        });
    };

    const renderLevel = (parentId: string | undefined, depth: number): ReactNode =>
        folderChildren(folders, parentId).map((folder) => {
            const hasChildren = folderChildren(folders, folder.id).length > 0;
            const expanded = expandedFolderIDs.has(folder.id);
            return (
                <div key={folder.id}>
                    <button
                        type="button"
                        data-folder-id={folder.id}
                        aria-current={currentFolderId === folder.id ? "page" : undefined}
                        aria-expanded={hasChildren ? expanded : undefined}
                        className={`flex min-h-9 w-full items-center rounded-md px-2 text-left text-sm transition hover:bg-stone-100 dark:hover:bg-stone-800 ${currentFolderId === folder.id ? "bg-stone-100 text-stone-950 dark:bg-stone-800 dark:text-stone-50" : "text-stone-700 dark:text-stone-200"}`}
                        style={{ paddingLeft: `${depth * 16 + 8}px` }}
                        onClick={() => toggleFolder(folder, hasChildren)}
                        onContextMenu={(event) => onFolderContextMenu(folder, event)}
                        onDragEnter={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                        }}
                        onDragOver={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            event.dataTransfer.dropEffect = "move";
                        }}
                        onDrop={(event) => onDropImage(folder.id, event)}
                    >
                        <span className="mr-1 w-3 shrink-0 text-center text-xs text-stone-400" aria-hidden>
                            {hasChildren ? (expanded ? "−" : "+") : ""}
                        </span>
                        <Folder className="mr-2 size-4 shrink-0 text-stone-400" aria-hidden />
                        <span className="truncate">{folder.name}</span>
                    </button>
                    {hasChildren && expanded ? renderLevel(folder.id, depth + 1) : null}
                </div>
            );
        });

    return (
        <div className="space-y-0.5" aria-label="素材文件夹树">
            {renderLevel(undefined, 0)}
        </div>
    );
}
