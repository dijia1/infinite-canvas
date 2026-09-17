"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { WorkflowImageMenu } from "./workflow-image-download";

type Props = { menu: WorkflowImageMenu; count: number; loading: boolean; failed: boolean; busy: boolean; onDownload: () => void; onRetry: () => void; onClose: () => void };

export function WorkflowImageContextMenu({ menu, count, loading, failed, busy, onDownload, onRetry, onClose }: Props) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;
        const bounds = element.getBoundingClientRect();
        element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`;
        element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`;
    }, [menu, loading, failed, count, busy]);
    useEffect(() => {
        const close = () => onClose();
        const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
        // Close before the canvas resets selection and synchronously replaces its listeners.
        const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } };
        window.addEventListener("pointerdown", outside, true);
        window.addEventListener("keydown", key, true);
        window.addEventListener("blur", close);
        return () => { window.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", key, true); window.removeEventListener("blur", close); };
    }, [onClose]);
    const label = busy ? "正在下载图片…" : failed ? "图片信息读取失败，点击重试" : loading ? "正在读取图片…" : count > 1 ? `下载选中图片（${count}）` : count === 1 ? "下载图片" : "没有可下载的图片";
    return createPortal(<div ref={ref} role="menu" aria-label="图片下载" className="fixed z-[80] min-w-44 overflow-hidden rounded-lg border py-1 shadow-lg" style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} onPointerDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
        <button type="button" role="menuitem" disabled={busy || (!failed && (loading || !count))} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:opacity-80 disabled:cursor-default disabled:opacity-50" onClick={failed ? onRetry : onDownload}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : failed ? <RefreshCw className="size-4" /> : loading ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
            {label}
        </button>
    </div>, document.body);
}
