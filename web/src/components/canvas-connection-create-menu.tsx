"use client";

import type { ReactNode } from "react";
import type { CanvasTheme } from "@/lib/canvas-theme";

type ConnectionCreateOption = {
    id: string;
    icon: ReactNode;
    title: string;
    description?: string;
    onClick: () => void;
};

export function CanvasConnectionCreateMenu({ title, position, theme, options, onClose }: {
    title: string;
    position: { x: number; y: number };
    theme: CanvasTheme;
    options: ConnectionCreateOption[];
    onClose: () => void;
}) {
    return (
        <div
            className="absolute z-[120] w-[300px] rounded-[18px] border p-3 shadow-2xl backdrop-blur"
            data-connection-create-menu
            style={{ left: position.x, top: position.y, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
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
