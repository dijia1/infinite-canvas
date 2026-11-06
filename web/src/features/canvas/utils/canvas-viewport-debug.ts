import type { ViewportTransform } from "../types";
import { CANVAS_NODE_RENDER_PADDING } from "./canvas-node-visibility";
import { getCanvasViewportBounds } from "./canvas-viewport-bounds";

type CanvasViewportSize = {
    width: number;
    height: number;
};

export type CanvasViewportDebugNode = {
    id: string;
    position: { x: number; y: number };
    width: number;
    height: number;
};

type CanvasViewportDebugInput = {
    sceneViewport: ViewportTransform;
    cullingViewport: ViewportTransform;
    viewportSize: CanvasViewportSize;
    renderedNodeCount: number;
    renderedConnectionCount: number;
    selectedNode?: CanvasViewportDebugNode | null;
};

export function isLocalCanvasViewportDebugEnabled(location: Pick<Location, "hostname" | "search">) {
    const isLocalHost = location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "::1";
    return isLocalHost && new URLSearchParams(location.search).get("canvas-debug") === "1";
}

export function isCanvasViewportDebugEnabled() {
    return typeof window !== "undefined" && isLocalCanvasViewportDebugEnabled(window.location);
}

export function buildCanvasViewportDebugSnapshot({ sceneViewport, cullingViewport, viewportSize, renderedNodeCount, renderedConnectionCount, selectedNode }: CanvasViewportDebugInput) {
    const selectedNodeScreenBounds = selectedNode
        ? {
              left: selectedNode.position.x * sceneViewport.k + sceneViewport.x,
              top: selectedNode.position.y * sceneViewport.k + sceneViewport.y,
              right: (selectedNode.position.x + selectedNode.width) * sceneViewport.k + sceneViewport.x,
              bottom: (selectedNode.position.y + selectedNode.height) * sceneViewport.k + sceneViewport.y,
          }
        : null;

    return {
        sceneViewport,
        cullingViewport,
        viewportSize,
        cullingBounds: getCanvasViewportBounds(cullingViewport, viewportSize, CANVAS_NODE_RENDER_PADDING),
        drift: {
            x: sceneViewport.x - cullingViewport.x,
            y: sceneViewport.y - cullingViewport.y,
            scalePercent: ((sceneViewport.k / cullingViewport.k) - 1) * 100,
        },
        screenPadding: CANVAS_NODE_RENDER_PADDING,
        renderedNodeCount,
        renderedConnectionCount,
        selectedNode: selectedNode && selectedNodeScreenBounds
            ? {
                  id: selectedNode.id,
                  screenBounds: selectedNodeScreenBounds,
                  edgeDistance: {
                      left: selectedNodeScreenBounds.left,
                      top: selectedNodeScreenBounds.top,
                      right: viewportSize.width - selectedNodeScreenBounds.right,
                      bottom: viewportSize.height - selectedNodeScreenBounds.bottom,
                  },
              }
            : null,
    };
}
