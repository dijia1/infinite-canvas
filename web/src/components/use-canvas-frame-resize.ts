"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { CanvasFrameData, CanvasFrameResizeDirection } from "@/lib/canvas-frame";
import { canvasFrameResizeCursor, hitTestCanvasFrames, type CanvasFrameResizeHit, type CanvasFrameViewport } from "@/lib/canvas-frame-interaction";

import styles from "./canvas-frame.module.css";

type Options = {
    containerRef: RefObject<HTMLDivElement | null>;
    frames: readonly CanvasFrameData[];
    selectedFrameId?: string;
    readOnly: boolean;
    active: boolean;
    getViewport: () => CanvasFrameViewport;
    onSelect: (frameId: string) => void;
    onResizeStart: (event: PointerEvent, frame: CanvasFrameData, direction: CanvasFrameResizeDirection) => void;
};

export function useCanvasFrameResize(options: Options) {
    const latest = useRef(options);
    latest.current = options;
    const [hover, setHover] = useState<CanvasFrameResizeHit | null>(null);
    const refreshRef = useRef<() => void>(() => {});
    const connected = useRef<HTMLDivElement | null>(null);
    const disconnect = useRef<(() => void) | null>(null);
    useEffect(() => {
        const container = options.containerRef.current;
        if (connected.current === container) return;
        disconnect.current?.();
        setHover(null);
        connected.current = container;
        if (!container) return;
        let pointer: { clientX: number; clientY: number } | null = null;
        let current: CanvasFrameResizeHit | null = null;
        const show = (hit: CanvasFrameResizeHit | null) => {
            if (current?.frameId === hit?.frameId && current?.direction === hit?.direction) return;
            if (hit) {
                container.setAttribute("data-canvas-frame-resize-cursor", hit.direction);
                container.classList.add(styles.resizeCursor);
                container.style.setProperty("--canvas-frame-resize-cursor", canvasFrameResizeCursor(hit.direction));
            } else {
                container.removeAttribute("data-canvas-frame-resize-cursor");
            container.classList.remove(styles.resizeCursor);
                container.style.removeProperty("--canvas-frame-resize-cursor");
            }
            setHover(hit);
            current = hit;
        };
        const blocked = (target: Element | null) => Boolean(target?.closest("[data-node-id],[data-connection-id],[data-canvas-frame-actions],input,textarea,[contenteditable=true],[data-canvas-no-zoom],[data-connection-create-menu],.ant-dropdown,.ant-popover,.ant-modal"));
        const resolve = () => {
            const opt = latest.current;
            if (!pointer || opt.readOnly) return null;
            const rect = container.getBoundingClientRect();
            const hit = hitTestCanvasFrames(opt.frames, { x: pointer.clientX - rect.left, y: pointer.clientY - rect.top }, opt.getViewport(), opt.selectedFrameId);
            if (!hit) return null;
            const target = document.elementFromPoint(pointer.clientX, pointer.clientY);
            if (!target || !container.contains(target) || blocked(target)) return null;
            return hit;
        };
        const refresh = () => { if (!latest.current.active) show(resolve()); };
        refreshRef.current = refresh;
        const move = (event: PointerEvent) => {
            pointer = event;
            if (!event.buttons) refresh();
        };
        const down = (event: PointerEvent) => {
            if (event.button !== 0 || latest.current.active) return;
            pointer = event;
            const hit = resolve();
            show(hit);
            if (!hit) return;
            const frame = latest.current.frames.find((item) => item.id === hit.frameId);
            if (!frame) return;
            event.preventDefault(); event.stopPropagation();
            latest.current.onSelect(frame.id);
            latest.current.onResizeStart(event, frame, hit.direction);
        };
        const leave = () => { pointer = null; if (!latest.current.active) show(null); };
        container.addEventListener("pointermove", move, true);
        container.addEventListener("pointerdown", down, true);
        container.addEventListener("pointerleave", leave);
        container.addEventListener("canvasviewportchange", refresh);
        window.addEventListener("blur", leave);
        disconnect.current = () => {
            container.removeEventListener("pointermove", move, true);
            container.removeEventListener("pointerdown", down, true);
            container.removeEventListener("pointerleave", leave);
            container.removeEventListener("canvasviewportchange", refresh);
            window.removeEventListener("blur", leave);
            container.removeAttribute("data-canvas-frame-resize-cursor");
            container.classList.remove(styles.resizeCursor);
            container.style.removeProperty("--canvas-frame-resize-cursor");
            refreshRef.current = () => {};
        };
    });
    useEffect(() => () => { disconnect.current?.(); connected.current = null; }, []);
    useEffect(() => { refreshRef.current(); }, [options.frames, options.readOnly, options.active, options.selectedFrameId]);
    return hover;
}
