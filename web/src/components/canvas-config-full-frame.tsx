"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CONFIG_NODE_MIN_SIZE } from "@/lib/canvas-config-card";

export function CanvasConfigFullFrame({ width, height, children, style }: { width: number; height: number; children: ReactNode; style?: CSSProperties }) {
    const layoutRef = useRef<HTMLDivElement>(null);
    const [layoutHeight, setLayoutHeight] = useState(CONFIG_NODE_MIN_SIZE.height);
    // Content controls the fit scale, never the saved node geometry.
    useLayoutEffect(() => {
        const layout = layoutRef.current;
        if (!layout) return;
        const syncHeight = () => setLayoutHeight(Math.ceil(layout.offsetHeight) + 4);
        syncHeight();
        const observer = new ResizeObserver(syncHeight);
        observer.observe(layout);
        return () => observer.disconnect();
    }, []);
    const scale = Math.min((width - 4) / CONFIG_NODE_MIN_SIZE.width, (height - 4) / layoutHeight);
    return (
        <div className="canvas-config-full-frame" style={{ ...style, width: CONFIG_NODE_MIN_SIZE.width, height: layoutHeight, transform: `translate(-50%, -50%) scale(${scale})` }}>
            <div ref={layoutRef} className="canvas-config-full canvas-config-view-transition flex min-w-0 w-full shrink-0 cursor-move flex-col gap-8 px-3 py-4 text-sm">
                {children}
            </div>
        </div>
    );
}
