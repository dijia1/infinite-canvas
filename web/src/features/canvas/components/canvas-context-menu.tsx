"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { Download, Plus, Trash2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ContextMenuState } from "../types";

export function CanvasNodeContextMenu({ menu, onClose, onDuplicate, onDelete, downloadCount = 0, downloadBusy = false, onDownloadSelected }: { menu: ContextMenuState; onClose: () => void; onDuplicate: () => void; onDelete: () => void; downloadCount?: number; downloadBusy?: boolean; onDownloadSelected?: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            className="fixed z-[80] min-w-44 overflow-hidden rounded-xl border py-1 shadow-2xl"
            style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {downloadCount > 1 ? <MenuButton icon={<Download className="size-4" />} label={downloadBusy ? "正在下载图片…" : `下载选中图片（${downloadCount}）`} disabled={downloadBusy} onClick={onDownloadSelected} /> : null}
            <MenuButton icon={<Plus className="size-4" />} label="Duplicate" onClick={onDuplicate} />
            <MenuButton icon={<Trash2 className="size-4" />} label="Delete" onClick={onDelete} danger />
        </div>
    );
}

function MenuButton({ icon, label, onClick, danger = false, disabled = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean; disabled?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button type="button" disabled={disabled} className="disabled:cursor-default disabled:opacity-50 flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" style={{ color: danger ? "#f87171" : theme.node.text }} onClick={onClick}>
            {icon}
            <span>{label}</span>
        </button>
    );
}
