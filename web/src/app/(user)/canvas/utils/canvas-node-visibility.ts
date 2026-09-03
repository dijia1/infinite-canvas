import type { CanvasNodeData, ViewportTransform } from "../types";
import { getCanvasViewportBounds, intersectsCanvasViewportBounds } from "./canvas-viewport-bounds";

export const CANVAS_NODE_RENDER_PADDING = 64;

export function isCanvasNodeNearViewport(node: CanvasNodeData, viewport: ViewportTransform, viewportSize: { width: number; height: number }, screenPadding = CANVAS_NODE_RENDER_PADDING) {
    return intersectsCanvasViewportBounds(
        {
            left: node.position.x,
            top: node.position.y,
            right: node.position.x + node.width,
            bottom: node.position.y + node.height,
        },
        getCanvasViewportBounds(viewport, viewportSize, screenPadding),
    );
}
