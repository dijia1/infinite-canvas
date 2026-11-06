import type { ViewportTransform } from "../types";

export type CanvasViewportBounds = {
    left: number;
    top: number;
    right: number;
    bottom: number;
};

type CanvasViewportSize = {
    width: number;
    height: number;
};

export function getCanvasViewportBounds(viewport: ViewportTransform, viewportSize: CanvasViewportSize, screenPadding = 0): CanvasViewportBounds {
    const padding = screenPadding / Math.max(viewport.k, Number.EPSILON);
    return {
        left: -viewport.x / viewport.k - padding,
        top: -viewport.y / viewport.k - padding,
        right: (-viewport.x + viewportSize.width) / viewport.k + padding,
        bottom: (-viewport.y + viewportSize.height) / viewport.k + padding,
    };
}

export function intersectsCanvasViewportBounds(bounds: CanvasViewportBounds, viewportBounds: CanvasViewportBounds) {
    return bounds.right >= viewportBounds.left && bounds.left <= viewportBounds.right && bounds.bottom >= viewportBounds.top && bounds.top <= viewportBounds.bottom;
}
