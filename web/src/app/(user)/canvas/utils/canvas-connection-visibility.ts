import type { CanvasConnection, Position, ViewportTransform } from "../types";
import { getCanvasViewportBounds, intersectsCanvasViewportBounds } from "./canvas-viewport-bounds";

const CONNECTION_VIEWPORT_PADDING = 64;

type ConnectionEndpoint = { position: Position; width: number; height: number };

export function shouldRenderCanvasConnection(connection: CanvasConnection, visibleNodeIds: ReadonlySet<string>, isInteractive = false) {
    return isInteractive || (visibleNodeIds.has(connection.fromNodeId) && visibleNodeIds.has(connection.toNodeId));
}

export function isCanvasConnectionNearViewport(from: ConnectionEndpoint, to: ConnectionEndpoint, viewport: ViewportTransform, viewportSize: { width: number; height: number }) {
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
    const bounds = {
        left: Math.min(startX, endX, startX + curvature, endX - curvature),
        right: Math.max(startX, endX, startX + curvature, endX - curvature),
        top: Math.min(startY, endY),
        bottom: Math.max(startY, endY),
    };
    return intersectsCanvasViewportBounds(bounds, getCanvasViewportBounds(viewport, viewportSize, CONNECTION_VIEWPORT_PADDING));
}
