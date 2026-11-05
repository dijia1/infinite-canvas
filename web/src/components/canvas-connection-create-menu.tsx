"use client";

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Position, ViewportTransform } from "@/app/(user)/canvas/types";
import type { CanvasTheme } from "@/lib/canvas-theme";

type ConnectionCreateOption = {
    id: string;
    icon: ReactNode;
    title: string;
    description?: string;
    onClick: () => void;
};

type ConnectionCreateMenuContentProps = {
    title: string;
    theme: CanvasTheme;
    options: ConnectionCreateOption[];
    onClose: () => void;
    ref?: RefObject<HTMLDivElement | null>;
};

export function connectionMenuPosition(position: Position, viewport: ViewportTransform, size: { width: number; height: number }, menu: { width: number; height: number }) {
    const x = viewport.x + position.x * viewport.k;
    const y = viewport.y + position.y * viewport.k;
    const top = y + menu.height > size.height - 12 ? y - menu.height : y;
    return {
        left: Math.max(12, Math.min(x, size.width - menu.width - 12)),
        top: Math.max(12, Math.min(top, size.height - menu.height - 12)),
    };
}

export function CanvasConnectionCreateMenu({ position, containerRef, getViewport, ...content }: ConnectionCreateMenuContentProps & {
    position: Position;
    containerRef: RefObject<HTMLDivElement | null>;
    getViewport: () => ViewportTransform | undefined;
}) {
    const menuRef = useRef<HTMLDivElement>(null);
    const [container, setContainer] = useState<HTMLDivElement | null>(null);
    useLayoutEffect(() => setContainer(containerRef.current), [containerRef]);
    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (!container || !menu) return;
        const update = () => {
            const viewport = getViewport();
            if (!viewport) return;
            menu.style.maxWidth = `${container.clientWidth - 24}px`;
            menu.style.maxHeight = `${container.clientHeight - 24}px`;
            const placement = connectionMenuPosition(position, viewport, { width: container.clientWidth, height: container.clientHeight }, { width: menu.offsetWidth, height: menu.offsetHeight });
            menu.style.left = `${placement.left}px`;
            menu.style.top = `${placement.top}px`;
            menu.style.visibility = "visible";
        };
        update();
        container.addEventListener("canvasviewportchange", update);
        const observer = new ResizeObserver(update);
        observer.observe(container);
        observer.observe(menu);
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") content.onClose();
        };
        window.addEventListener("keydown", closeOnEscape);
        return () => {
            container.removeEventListener("canvasviewportchange", update);
            observer.disconnect();
            window.removeEventListener("keydown", closeOnEscape);
        };
    }, [container, getViewport, content.onClose, position]);

    if (!container) return null;
    return createPortal(<CanvasConnectionCreateMenuContent {...content} ref={menuRef} />, container);
}

export function CanvasConnectionCreateMenuContent({ title, theme, options, onClose, ref }: ConnectionCreateMenuContentProps) {
    return (
        <div
            ref={ref}
            className="absolute z-[120] w-[300px] overflow-y-auto overscroll-contain rounded-[18px] border p-3 shadow-2xl backdrop-blur"
            data-connection-create-menu
            data-canvas-no-zoom
            style={{ visibility: "hidden", background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onWheel={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>{title}</span>
                <button type="button" className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:bg-white/10 hover:opacity-100" onClick={onClose} aria-label="关闭连接菜单">
                    ×
                </button>
            </div>
            <div className="grid gap-1">
                {options.map((option) => (
                    <button
                        key={option.id}
                        type="button"
                        className="flex h-16 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left transition"
                        style={{ color: theme.node.text }}
                        onClick={option.onClick}
                        onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
                        onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
                    >
                        <span className="grid size-11 shrink-0 place-items-center rounded-xl" style={{ background: theme.node.fill, color: theme.node.muted }}>{option.icon}</span>
                        <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2 text-base font-semibold leading-5">{option.title}</span>
                            {option.description ? <span className="mt-1 block truncate text-sm" style={{ color: theme.node.muted }}>{option.description}</span> : null}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}
