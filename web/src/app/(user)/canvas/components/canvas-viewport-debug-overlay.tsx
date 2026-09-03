"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import type { ViewportTransform } from "../types";
import { buildCanvasViewportDebugSnapshot, isCanvasViewportDebugEnabled } from "../utils/canvas-viewport-debug";

type CanvasViewportDebugSnapshot = ReturnType<typeof buildCanvasViewportDebugSnapshot>;

type CanvasViewportDebugOverlayProps = {
    containerRef: RefObject<HTMLDivElement | null>;
    sceneRef: RefObject<HTMLDivElement | null>;
    sceneViewportRef: RefObject<ViewportTransform>;
    cullingViewport: ViewportTransform;
};

function format(value: number) {
    return Math.round(value * 10) / 10;
}

export function CanvasViewportDebugOverlay({ containerRef, sceneRef, sceneViewportRef, cullingViewport }: CanvasViewportDebugOverlayProps) {
    const [enabled, setEnabled] = useState(false);
    const [snapshot, setSnapshot] = useState<CanvasViewportDebugSnapshot | null>(null);
    const cullingViewportRef = useRef(cullingViewport);

    cullingViewportRef.current = cullingViewport;

    useEffect(() => {
        setEnabled(isCanvasViewportDebugEnabled());
    }, []);

    useEffect(() => {
        if (!enabled) return;

        const update = () => {
            const container = containerRef.current;
            const scene = sceneRef.current;
            if (!container || !scene) return;

            const rect = container.getBoundingClientRect();
            setSnapshot(
                buildCanvasViewportDebugSnapshot({
                    sceneViewport: sceneViewportRef.current,
                    cullingViewport: cullingViewportRef.current,
                    viewportSize: { width: rect.width, height: rect.height },
                    renderedNodeCount: scene.querySelectorAll("[data-node-id]").length,
                    renderedConnectionCount: scene.querySelectorAll(":scope > svg path").length,
                }),
            );
        };

        update();
        const interval = window.setInterval(update, 100);
        return () => window.clearInterval(interval);
    }, [containerRef, enabled, sceneRef, sceneViewportRef]);

    if (!enabled || !snapshot) return null;

    return (
        <aside className="pointer-events-none absolute right-3 top-3 z-[200] rounded border border-amber-400/50 bg-black/80 px-3 py-2 font-mono text-[10px] leading-5 text-amber-100 shadow-lg" data-canvas-viewport-debug>
            <div className="font-semibold text-amber-300">viewport debug · local only</div>
            <div>scene: {format(snapshot.sceneViewport.x)}, {format(snapshot.sceneViewport.y)} · {format(snapshot.sceneViewport.k * 100)}%</div>
            <div>cull: {format(snapshot.cullingViewport.x)}, {format(snapshot.cullingViewport.y)} · {format(snapshot.cullingViewport.k * 100)}%</div>
            <div>drift: {format(snapshot.drift.x)}, {format(snapshot.drift.y)} · {format(snapshot.drift.scalePercent)}%</div>
            <div>bounds: {format(snapshot.cullingBounds.left)}, {format(snapshot.cullingBounds.top)} → {format(snapshot.cullingBounds.right)}, {format(snapshot.cullingBounds.bottom)}</div>
            <div>padding: {snapshot.screenPadding}px · nodes: {snapshot.renderedNodeCount} · paths: {snapshot.renderedConnectionCount}</div>
        </aside>
    );
}
