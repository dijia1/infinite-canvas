import type { CanvasFrameData, CanvasFrameResizeDirection } from "./canvas-frame";

export type CanvasFrameViewport = { x: number; y: number; k: number };
export type CanvasFrameResizeHit = { frameId: string; direction: CanvasFrameResizeDirection; distance: number };

export function canvasFrameScreenMetrics(scale: number) {
    const amount = Math.max(0, Math.min(1, (1 - scale) / .7));
    return { border: 2 + amount, edge: 16 + 12 * amount, corner: 24 + 12 * amount };
}

// Hit tests use screen coordinates, independent of React's throttled viewport commits.
export function hitTestCanvasFrames(frames: readonly CanvasFrameData[], point: { x: number; y: number }, viewport: CanvasFrameViewport, selectedFrameId?: string): CanvasFrameResizeHit | null {
    if (!Number.isFinite(viewport.k) || viewport.k <= 0) return null;
    const metrics = canvasFrameScreenMetrics(viewport.k);
    let best: CanvasFrameResizeHit | null = null;
    for (const frame of frames) {
        const left = frame.position.x * viewport.k + viewport.x, top = frame.position.y * viewport.k + viewport.y;
        const width = frame.width * viewport.k, height = frame.height * viewport.k;
        const right = left + width, bottom = top + height;
        const outside = metrics.edge * .75;
        const insideX = Math.min(metrics.edge * .25, width / 4), insideY = Math.min(metrics.edge * .25, height / 4);
        const cornerOutside = metrics.corner * .75;
        const cornerX = Math.min(metrics.corner * .25, width / 4), cornerY = Math.min(metrics.corner * .25, height / 4);
        let hit: CanvasFrameResizeHit | null = null;
        const corners = [
            ["top-left", left, top, point.x >= left - cornerOutside && point.x <= left + cornerX && point.y >= top - cornerOutside && point.y <= top + cornerY],
            ["top-right", right, top, point.x >= right - cornerX && point.x <= right + cornerOutside && point.y >= top - cornerOutside && point.y <= top + cornerY],
            ["bottom-left", left, bottom, point.x >= left - cornerOutside && point.x <= left + cornerX && point.y >= bottom - cornerY && point.y <= bottom + cornerOutside],
            ["bottom-right", right, bottom, point.x >= right - cornerX && point.x <= right + cornerOutside && point.y >= bottom - cornerY && point.y <= bottom + cornerOutside],
        ] as const;
        for (const [direction, x, y, contains] of corners) if (contains) {
            const distance = Math.hypot(point.x - x, point.y - y);
            if (!hit || distance < hit.distance) hit = { frameId: frame.id, direction, distance };
        }
        if (!hit) {
            const edges = [
                ["left", Math.abs(point.x - left), point.x >= left - outside && point.x <= left + insideX && point.y >= top && point.y <= bottom],
                ["right", Math.abs(point.x - right), point.x >= right - insideX && point.x <= right + outside && point.y >= top && point.y <= bottom],
                ["top", Math.abs(point.y - top), point.y >= top - outside && point.y <= top + insideY && point.x >= left && point.x <= right],
                ["bottom", Math.abs(point.y - bottom), point.y >= bottom - insideY && point.y <= bottom + outside && point.x >= left && point.x <= right],
            ] as const;
            for (const [direction, distance, contains] of edges) if (contains && (!hit || distance < hit.distance)) hit = { frameId: frame.id, direction, distance };
        }
        if (hit && (!best || hit.distance < best.distance || (hit.distance === best.distance && (hit.frameId === selectedFrameId || (best.frameId !== selectedFrameId && hit.frameId < best.frameId))))) best = hit;
    }
    return best;
}

export const canvasFrameResizeCursor = (direction: CanvasFrameResizeDirection) => direction === "left" || direction === "right" ? "ew-resize" : direction === "top" || direction === "bottom" ? "ns-resize" : direction === "top-left" || direction === "bottom-right" ? "nwse-resize" : "nesw-resize";
