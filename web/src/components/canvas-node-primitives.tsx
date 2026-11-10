"use client";

import type { CSSProperties, HTMLAttributes, MouseEvent, PointerEvent } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

import type { CanvasResizeCorner } from "@/lib/canvas-resize";
export type { CanvasResizeCorner } from "@/lib/canvas-resize";
export const canvasResizeCorners: CanvasResizeCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
export const canvasNodeSelectionColor = "#2f80ff";

// Draw inside the card so overview paint containment cannot clip the selection.
// The scene updates inverse scale in the same RAF as its viewport transform.
export function CanvasNodeSelectionOutline({ color = canvasNodeSelectionColor, inset = 0 }: { color?: string; inset?: number }) {
    return <div
        aria-hidden="true"
        data-canvas-selection-outline
        className="pointer-events-none absolute z-40 rounded-[inherit]"
        style={{
            inset,
            boxShadow: `inset 0 0 0 calc(2px * var(--canvas-inverse-scale, 1)) ${color}`,
        }}
    />;
}

export function CanvasNodeFrame({ children, selected = false, ...props }: HTMLAttributes<HTMLDivElement> & { selected?: boolean }) {
    return (
        <div
            {...props}
            className={`relative h-full w-full overflow-visible rounded-3xl border-2 ${props.className || ""}`}
            style={{ ...props.style, ...(selected ? { borderColor: "transparent", boxShadow: "none" } : {}) }}
        >
            {children}
            {selected ? <CanvasNodeSelectionOutline inset={-2} /> : null}
        </div>
    );
}

export function CanvasResizeHandle({
    corner,
    onMouseDown,
    onPointerDown,
}: {
    corner: CanvasResizeCorner;
    onMouseDown?: (event: MouseEvent<HTMLDivElement>, corner: CanvasResizeCorner) => void;
    onPointerDown?: (event: PointerEvent<HTMLDivElement>, corner: CanvasResizeCorner) => void;
}) {
    const positionClass = {
        "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
        "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
        "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
        "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
    }[corner];
    return (
        <div
            data-canvas-resize={corner}
            className={`absolute z-50 size-7 ${positionClass}`}
            onMouseDown={onMouseDown ? (event) => onMouseDown(event, corner) : undefined}
            onPointerDown={onPointerDown ? (event) => onPointerDown(event, corner) : undefined}
        />
    );
}

export function CanvasConnectionHandle({
    nodeWidth,
    nodeHeight,
    side,
    visible,
    label,
    onMouseDown,
    onPointerDown,
}: {
    nodeWidth: number;
    nodeHeight: number;
    side: "left" | "right";
    visible: boolean;
    label?: string;
    onMouseDown?: (event: MouseEvent<HTMLDivElement>) => void;
    onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div
            data-canvas-connection={side}
            aria-label={label}
            className={`group/connection absolute top-1/2 z-30 flex -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150 ${side === "left" ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2"} ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
            style={{
                // The zoom transform and inverse scale change together; CSS keeps this
                // screen-space limit current without subscribing every node to zoom.
                "--canvas-connection-hit-size": `min(calc(28px * var(--canvas-inverse-scale, 1)), ${Math.min(nodeWidth, nodeHeight) * 0.4}px)`,
                width: "var(--canvas-connection-hit-size)",
                height: "var(--canvas-connection-hit-size)",
            } as CSSProperties}
            onMouseDown={onMouseDown ? (event) => { if (event.button === 0) onMouseDown(event); } : undefined}
            onPointerDown={onPointerDown ? (event) => { if (event.button === 0) onPointerDown(event); } : undefined}
        >
            <div className="rounded-full border-solid transition-[filter] group-hover/connection:brightness-125" style={{ width: "min(calc(12px * var(--canvas-inverse-scale, 1)), calc(var(--canvas-connection-hit-size) / 2))", height: "min(calc(12px * var(--canvas-inverse-scale, 1)), calc(var(--canvas-connection-hit-size) / 2))", borderWidth: "min(calc(2px * var(--canvas-inverse-scale, 1)), calc(var(--canvas-connection-hit-size) / 12))", background: theme.node.panel, borderColor: theme.node.text }} />
        </div>
    );
}

export function CanvasInputChip({ label, value, style }: { label: string; value: string; style: CSSProperties }) {
    return (
        <div className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]" style={style}>
            <span>{label}</span>
            <span className="font-medium">{value}</span>
        </div>
    );
}

export function CanvasInputBadge({ label, kind = "image" }: { label: string; kind?: "image" | "video" | "text" }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return <div className={`pointer-events-none absolute z-40 ${kind === "text" ? "left-3 top-3" : "left-1/2 top-full -translate-x-1/2 pt-2"}`}>
        <span className="inline-flex h-7 items-center rounded-full border px-2.5 text-[11px] font-semibold shadow-[0_8px_18px_rgba(15,23,42,.12)] backdrop-blur-md" style={{ background: `${theme.toolbar.panel}dd`, borderColor: theme.node.stroke, color: theme.node.text }}>{label}</span>
    </div>;
}
