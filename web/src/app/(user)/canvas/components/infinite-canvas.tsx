"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "../types";
import { createCanvasViewportCommitScheduler } from "../utils/canvas-viewport-commit-scheduler";
import { CanvasViewportDebugOverlay } from "./canvas-viewport-debug-overlay";

type InfiniteCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    cursor?: React.CSSProperties["cursor"];
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
};

export type CanvasPanState = {
    isPanning: boolean;
    startX: number;
    startY: number;
    initialX: number;
    initialY: number;
    hasMoved: boolean;
};

export function finishCanvasPan(state: CanvasPanState, onCanvasDeselect?: () => void) {
    if (!state.isPanning) return false;
    if (!state.hasMoved) onCanvasDeselect?.();
    state.isPanning = false;
    return true;
}

export function InfiniteCanvas({ containerRef, viewport, cursor, backgroundMode = "lines", onViewportChange, onCanvasMouseDown, onCanvasDeselect, onContextMenu, onDrop, children }: InfiniteCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef<CanvasPanState>({
        isPanning: false,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
    });
    const scaleRef = useRef(viewport.k);
    const viewportRef = useRef(viewport);
    const frameRef = useRef<number | null>(null);
    const wheelFrameRef = useRef<number | null>(null);
    const wheelEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const nextWheelViewportRef = useRef<ViewportTransform | null>(null);
    const sceneRef = useRef<HTMLDivElement | null>(null);
    const gridRef = useRef<HTMLDivElement | null>(null);
    const onViewportChangeRef = useRef(onViewportChange);
    const isViewportManipulatingRef = useRef(false);
    const viewportCommitSchedulerRef = useRef<ReturnType<typeof createCanvasViewportCommitScheduler> | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);

    onViewportChangeRef.current = onViewportChange;
    if (!viewportCommitSchedulerRef.current) {
        viewportCommitSchedulerRef.current = createCanvasViewportCommitScheduler({
            onCommit: (nextViewport) => onViewportChangeRef.current(nextViewport),
        });
    }

    const applyViewport = useCallback((nextViewport: ViewportTransform) => {
        viewportRef.current = nextViewport;
        scaleRef.current = nextViewport.k;
        const scene = sceneRef.current;
        if (scene) scene.style.transform = `translate3d(${nextViewport.x}px, ${nextViewport.y}px, 0) scale(${nextViewport.k})`;
        const grid = gridRef.current;
        if (!grid) return;
        const gridSize = 48 * nextViewport.k;
        grid.style.backgroundSize = `${gridSize}px ${gridSize}px`;
        grid.style.backgroundPosition = `${nextViewport.x % gridSize}px ${nextViewport.y % gridSize}px`;
    }, []);

    const scheduleViewportCommit = useCallback((nextViewport: ViewportTransform, force = false) => {
        const scheduler = viewportCommitSchedulerRef.current;
        if (!scheduler) return;
        const now = performance.now();
        if (force) scheduler.flush(nextViewport, now);
        else scheduler.update(nextViewport, now);
    }, []);

    const handlePointerEnd = useCallback(() => {
        if (!finishCanvasPan(panState.current, onCanvasDeselect)) return;
        const finalViewport = nextViewportRef.current || viewportRef.current;
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
        nextViewportRef.current = null;
        isViewportManipulatingRef.current = false;
        applyViewport(finalViewport);
        scheduleViewportCommit(finalViewport, true);
        document.body.style.cursor = "default";
    }, [applyViewport, onCanvasDeselect, scheduleViewportCommit]);

    useLayoutEffect(() => {
        if (isViewportManipulatingRef.current && !sameViewport(viewport, viewportRef.current)) return;
        applyViewport(viewport);
    }, [applyViewport, viewport]);

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (wheelFrameRef.current) cancelAnimationFrame(wheelFrameRef.current);
            if (wheelEndTimerRef.current) clearTimeout(wheelEndTimerRef.current);
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.code !== "Space") return;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") setIsSpacePressed(false);
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
        };
    }, []);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;

        const currentViewport = nextWheelViewportRef.current || viewportRef.current;
        const delta = -event.deltaY;
        const factor = Math.pow(1.1, delta / 100);
        const newScale = Math.min(Math.max(currentViewport.k * factor, 0.05), 5);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const worldX = (mouseX - currentViewport.x) / currentViewport.k;
        const worldY = (mouseY - currentViewport.y) / currentViewport.k;

        nextWheelViewportRef.current = {
            x: mouseX - worldX * newScale,
            y: mouseY - worldY * newScale,
            k: newScale,
        };
        isViewportManipulatingRef.current = true;
        if (wheelEndTimerRef.current) clearTimeout(wheelEndTimerRef.current);
        wheelEndTimerRef.current = setTimeout(() => {
            wheelEndTimerRef.current = null;
            isViewportManipulatingRef.current = false;
            scheduleViewportCommit(viewportRef.current, true);
        }, 120);
        if (wheelFrameRef.current) return;
        wheelFrameRef.current = requestAnimationFrame(() => {
            wheelFrameRef.current = null;
            const nextViewport = nextWheelViewportRef.current;
            nextWheelViewportRef.current = null;
            if (!nextViewport) return;
            applyViewport(nextViewport);
            scheduleViewportCommit(nextViewport);
        });
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");

        if (event.button === 1 || (event.button === 0 && isSpacePressed && isBackgroundClick)) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            if (wheelEndTimerRef.current) {
                clearTimeout(wheelEndTimerRef.current);
                wheelEndTimerRef.current = null;
            }
            const currentViewport = viewportRef.current;
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: currentViewport.x,
                initialY: currentViewport.y,
                hasMoved: false,
            };
            isViewportManipulatingRef.current = true;
            document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
        }
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;

            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            nextViewportRef.current = {
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: scaleRef.current,
            };
            if (frameRef.current) return;
            frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                const nextViewport = nextViewportRef.current;
                if (!nextViewport) return;
                applyViewport(nextViewport);
                scheduleViewportCommit(nextViewport);
            });
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerEnd);
        window.addEventListener("pointercancel", handlePointerEnd);
        window.addEventListener("blur", handlePointerEnd);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerEnd);
            window.removeEventListener("pointercancel", handlePointerEnd);
            window.removeEventListener("blur", handlePointerEnd);
        };
    }, [applyViewport, handlePointerEnd, scheduleViewportCommit]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const preventWheelScroll = (event: WheelEvent) => event.preventDefault();
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventWheelScroll);
    }, [containerRef]);

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full cursor-grab select-none overflow-hidden"
            style={{ background: theme.canvas.background, cursor }}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onLostPointerCapture={handlePointerEnd}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <CanvasGrid viewport={viewport} mode={backgroundMode} gridRef={gridRef} />
            <div
                ref={sceneRef}
                className="absolute origin-top-left"
                style={{
                    willChange: "transform",
                }}
            >
                {children}
            </div>
            <CanvasViewportDebugOverlay containerRef={containerRef} sceneRef={sceneRef} sceneViewportRef={viewportRef} cullingViewport={viewport} />
        </div>
    );
}

function CanvasGrid({ viewport, mode, gridRef }: { viewport: ViewportTransform; mode: CanvasBackgroundMode; gridRef: { current: HTMLDivElement | null } }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = 48 * viewport.k;
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            ref={gridRef}
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
}

function sameViewport(left: ViewportTransform, right: ViewportTransform) {
    return left.x === right.x && left.y === right.y && left.k === right.k;
}
