import type { Position, ViewportTransform } from "../types";

const CONNECTION_VIEWPORT_PADDING = 240;

type ConnectionEndpoint = { position: Position; width: number; height: number };

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
    const viewportBounds = {
        left: -viewport.x / viewport.k - CONNECTION_VIEWPORT_PADDING,
        top: -viewport.y / viewport.k - CONNECTION_VIEWPORT_PADDING,
        right: (-viewport.x + viewportSize.width) / viewport.k + CONNECTION_VIEWPORT_PADDING,
        bottom: (-viewport.y + viewportSize.height) / viewport.k + CONNECTION_VIEWPORT_PADDING,
    };

    return bounds.right >= viewportBounds.left && bounds.left <= viewportBounds.right && bounds.bottom >= viewportBounds.top && bounds.top <= viewportBounds.bottom;
}
