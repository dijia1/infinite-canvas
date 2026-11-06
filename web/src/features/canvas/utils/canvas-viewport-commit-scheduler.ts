import type { ViewportTransform } from "../types";

const MAX_CULLING_PAN_DRIFT_PX = 32;
const MAX_CULLING_SCALE_RATIO = 1.05;

export type CanvasViewportCommitScheduler = {
    update: (viewport: ViewportTransform, now: number) => boolean;
    flush: (viewport: ViewportTransform, now: number) => boolean;
};

export function createCanvasViewportCommitScheduler({ minIntervalMs = 100, onCommit }: { minIntervalMs?: number; onCommit: (viewport: ViewportTransform) => void }): CanvasViewportCommitScheduler {
    let lastCommittedAt = Number.NEGATIVE_INFINITY;
    let lastCommittedViewport: ViewportTransform | null = null;

    const commit = (viewport: ViewportTransform, now: number) => {
        if (lastCommittedViewport && sameViewport(lastCommittedViewport, viewport)) return false;
        lastCommittedAt = now;
        lastCommittedViewport = viewport;
        onCommit(viewport);
        return true;
    };

    return {
        update(viewport, now) {
            if (now - lastCommittedAt < minIntervalMs && !hasExceededCullingDrift(lastCommittedViewport, viewport)) return false;
            return commit(viewport, now);
        },
        flush(viewport, now) {
            return commit(viewport, now);
        },
    };
}

function hasExceededCullingDrift(previous: ViewportTransform | null, next: ViewportTransform) {
    if (!previous) return true;
    if (Math.abs(next.x - previous.x) >= MAX_CULLING_PAN_DRIFT_PX || Math.abs(next.y - previous.y) >= MAX_CULLING_PAN_DRIFT_PX) return true;
    const scaleRatio = Math.max(next.k / previous.k, previous.k / next.k);
    return scaleRatio >= MAX_CULLING_SCALE_RATIO;
}

function sameViewport(left: ViewportTransform, right: ViewportTransform) {
    return left.x === right.x && left.y === right.y && left.k === right.k;
}
