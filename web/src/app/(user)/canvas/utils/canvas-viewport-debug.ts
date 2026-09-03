import type { ViewportTransform } from "../types";
import { CANVAS_NODE_RENDER_PADDING } from "./canvas-node-visibility";
import { getCanvasViewportBounds } from "./canvas-viewport-bounds";

type CanvasViewportSize = {
    width: number;
    height: number;
};

type CanvasViewportDebugInput = {
    sceneViewport: ViewportTransform;
    cullingViewport: ViewportTransform;
    viewportSize: CanvasViewportSize;
    renderedNodeCount: number;
    renderedConnectionCount: number;
};

export function isLocalCanvasViewportDebugEnabled(location: Pick<Location, "hostname" | "search">) {
    const isLocalHost = location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "::1";
    return isLocalHost && new URLSearchParams(location.search).get("canvas-debug") === "1";
}

export function isCanvasViewportDebugEnabled() {
    return typeof window !== "undefined" && isLocalCanvasViewportDebugEnabled(window.location);
}

export function buildCanvasViewportDebugSnapshot({ sceneViewport, cullingViewport, viewportSize, renderedNodeCount, renderedConnectionCount }: CanvasViewportDebugInput) {
    return {
        sceneViewport,
        cullingViewport,
        cullingBounds: getCanvasViewportBounds(cullingViewport, viewportSize, CANVAS_NODE_RENDER_PADDING),
        drift: {
            x: sceneViewport.x - cullingViewport.x,
            y: sceneViewport.y - cullingViewport.y,
            scalePercent: ((sceneViewport.k / cullingViewport.k) - 1) * 100,
        },
        screenPadding: CANVAS_NODE_RENDER_PADDING,
        renderedNodeCount,
        renderedConnectionCount,
    };
}
