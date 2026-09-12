export type CanvasFrameData = {
    id: string;
    name: string;
    position: { x: number; y: number };
    width: number;
    height: number;
    nodeIds: string[];
};

export type CanvasFrameRect = Pick<CanvasFrameData, "position" | "width" | "height">;
export type CanvasFrameBounds = CanvasFrameRect;
export type FrameDelta = { x: number; y: number };
export type CanvasFrameResizeDirection = "top" | "right" | "bottom" | "left" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const CANVAS_FRAME_PADDING = 24;
export const CANVAS_FRAME_HEADER_HEIGHT = 44;
export const CANVAS_FRAME_MIN_SIZE = { width: 240, height: 160 } as const;
export const MAX_CANVAS_FRAMES = 1000;

export function setFrameMembers(frames: CanvasFrameData[], nodeIds: readonly string[], targetFrameId: string | null): CanvasFrameData[] {
    if (!nodeIds.length || (targetFrameId !== null && !frames.some((frame) => frame.id === targetFrameId))) return frames;
    const members = new Set(nodeIds);
    let changed = false;
    const next = frames.map((frame) => {
        const frameNodeIds = frame.id === targetFrameId ? [...frame.nodeIds, ...nodeIds.filter((nodeId, index) => nodeIds.indexOf(nodeId) === index && !frame.nodeIds.includes(nodeId))] : frame.nodeIds.filter((nodeId) => !members.has(nodeId));
        if (sameStrings(frame.nodeIds, frameNodeIds)) return frame;
        changed = true;
        return { ...frame, nodeIds: frameNodeIds };
    });
    return changed ? next : frames;
}

export function canvasFrameBounds(rects: readonly CanvasFrameRect[]): CanvasFrameBounds | null {
    const valid = rects.filter(isFiniteRect);
    if (!valid.length) return null;
    const left = Math.min(...valid.map((rect) => rect.position.x)) - CANVAS_FRAME_PADDING;
    const top = Math.min(...valid.map((rect) => rect.position.y)) - CANVAS_FRAME_PADDING - CANVAS_FRAME_HEADER_HEIGHT;
    const right = Math.max(...valid.map((rect) => rect.position.x + rect.width)) + CANVAS_FRAME_PADDING;
    const bottom = Math.max(...valid.map((rect) => rect.position.y + rect.height)) + CANVAS_FRAME_PADDING;
    return { position: { x: left, y: top }, width: right - left, height: bottom - top };
}

export function canvasFrameContainsRect(container: CanvasFrameRect, rect: CanvasFrameRect): boolean {
    if (!isFiniteRect(container) || !isFiniteRect(rect)) return false;
    return rect.position.x >= container.position.x
        && rect.position.y >= container.position.y
        && rect.position.x + rect.width <= container.position.x + container.width
        && rect.position.y + rect.height <= container.position.y + container.height;
}

export function canvasFrameRectsOverlap(left: CanvasFrameRect, right: CanvasFrameRect): boolean {
    if (!isPositiveRect(left) || !isPositiveRect(right)) return false;
    return left.position.x < right.position.x + right.width
        && left.position.x + left.width > right.position.x
        && left.position.y < right.position.y + right.height
        && left.position.y + left.height > right.position.y;
}

export function constrainCanvasFrameTransition<T extends CanvasFrameRect>(start: T, requested: T, obstacles: readonly CanvasFrameRect[]): T {
    if (!isFiniteRect(start) || !isFiniteRect(requested)) return start;
    let limit = 1;
    for (const obstacle of obstacles) {
        if (!isPositiveRect(obstacle) || canvasFrameRectsOverlap(start, obstacle)) continue;
        const contact = canvasFrameContactTime(start, requested, obstacle);
        if (contact !== null) limit = Math.min(limit, contact);
    }
    if (limit === 1) return requested;
    if (limit === 0) return start;
    return {
        ...requested,
        position: {
            x: interpolate(start.position.x, requested.position.x, limit),
            y: interpolate(start.position.y, requested.position.y, limit),
        },
        width: interpolate(start.width, requested.width, limit),
        height: interpolate(start.height, requested.height, limit),
    };
}

export function constrainCanvasFrameDelta(frame: CanvasFrameRect, requestedDelta: FrameDelta, obstacles: readonly CanvasFrameRect[]): FrameDelta {
    if (!Number.isFinite(requestedDelta.x) || !Number.isFinite(requestedDelta.y)) return { x: 0, y: 0 };
    const constrained = constrainCanvasFrameTransition(frame, {
        ...frame,
        position: { x: frame.position.x + requestedDelta.x, y: frame.position.y + requestedDelta.y },
    }, obstacles);
    return { x: constrained.position.x - frame.position.x, y: constrained.position.y - frame.position.y };
}

export function expandCanvasFrame(frame: CanvasFrameData, rects: readonly CanvasFrameRect[]): CanvasFrameData {
    const bounds = canvasFrameBounds(rects);
    if (!bounds) return frame;
    const left = Math.min(frame.position.x, bounds.position.x);
    const top = Math.min(frame.position.y, bounds.position.y);
    const right = Math.max(frame.position.x + frame.width, bounds.position.x + bounds.width);
    const bottom = Math.max(frame.position.y + frame.height, bounds.position.y + bounds.height);
    if (left === frame.position.x && top === frame.position.y && right === frame.position.x + frame.width && bottom === frame.position.y + frame.height) return frame;
    return { ...frame, position: { x: left, y: top }, width: right - left, height: bottom - top };
}

export function resizeCanvasFrame(frame: CanvasFrameData, nextBounds: CanvasFrameBounds, memberRects: readonly CanvasFrameRect[] = []): CanvasFrameData {
    if (!isFiniteRect(nextBounds)) return frame;
    const candidate = {
        position: nextBounds.position,
        width: Math.max(CANVAS_FRAME_MIN_SIZE.width, nextBounds.width),
        height: Math.max(CANVAS_FRAME_MIN_SIZE.height, nextBounds.height),
    };
    const required = canvasFrameBounds(memberRects);
    const left = required ? Math.min(candidate.position.x, required.position.x) : candidate.position.x;
    const top = required ? Math.min(candidate.position.y, required.position.y) : candidate.position.y;
    const right = required ? Math.max(candidate.position.x + candidate.width, required.position.x + required.width) : candidate.position.x + candidate.width;
    const bottom = required ? Math.max(candidate.position.y + candidate.height, required.position.y + required.height) : candidate.position.y + candidate.height;
    if (left === frame.position.x && top === frame.position.y && right - left === frame.width && bottom - top === frame.height) return frame;
    return { ...frame, position: { x: left, y: top }, width: right - left, height: bottom - top };
}

export function resizeCanvasFrameFromHandle(frame: CanvasFrameData, direction: CanvasFrameResizeDirection, delta: FrameDelta, memberRects: readonly CanvasFrameRect[] = []): CanvasFrameData {
    if (!isFiniteRect(frame) || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return frame;
    const required = canvasFrameBounds(memberRects);
    let left = frame.position.x;
    let top = frame.position.y;
    let right = left + frame.width;
    let bottom = top + frame.height;

    if (direction.includes("left")) left = Math.min(left + delta.x, right - CANVAS_FRAME_MIN_SIZE.width, required?.position.x ?? Infinity);
    if (direction.includes("right")) right = Math.max(right + delta.x, left + CANVAS_FRAME_MIN_SIZE.width, required ? required.position.x + required.width : -Infinity);
    if (direction.includes("top")) top = Math.min(top + delta.y, bottom - CANVAS_FRAME_MIN_SIZE.height, required?.position.y ?? Infinity);
    if (direction.includes("bottom")) bottom = Math.max(bottom + delta.y, top + CANVAS_FRAME_MIN_SIZE.height, required ? required.position.y + required.height : -Infinity);

    if (left === frame.position.x && top === frame.position.y && right - left === frame.width && bottom - top === frame.height) return frame;
    return { ...frame, position: { x: left, y: top }, width: right - left, height: bottom - top };
}

function isFiniteRect(rect: CanvasFrameRect) {
    return Number.isFinite(rect.position.x) && Number.isFinite(rect.position.y) && Number.isFinite(rect.width) && rect.width >= 0 && Number.isFinite(rect.height) && rect.height >= 0;
}

function isPositiveRect(rect: CanvasFrameRect) {
    return isFiniteRect(rect) && rect.width > 0 && rect.height > 0;
}

function canvasFrameContactTime(start: CanvasFrameRect, requested: CanvasFrameRect, obstacle: CanvasFrameRect): number | null {
    let entry = -Infinity;
    let exit = Infinity;
    const inequalities: Array<[number, number]> = [
        [start.position.x + start.width - obstacle.position.x, requested.position.x + requested.width - start.position.x - start.width],
        [obstacle.position.x + obstacle.width - start.position.x, start.position.x - requested.position.x],
        [start.position.y + start.height - obstacle.position.y, requested.position.y + requested.height - start.position.y - start.height],
        [obstacle.position.y + obstacle.height - start.position.y, start.position.y - requested.position.y],
    ];

    for (const [initial, change] of inequalities) {
        if (change === 0) {
            if (initial <= 0) return null;
            continue;
        }
        const boundary = -initial / change;
        if (change > 0) entry = Math.max(entry, boundary);
        else exit = Math.min(exit, boundary);
    }

    const overlapStart = Math.max(0, entry);
    const overlapEnd = Math.min(1, exit);
    return overlapStart < overlapEnd && overlapStart < 1 ? overlapStart : null;
}

function interpolate(start: number, end: number, progress: number) {
    return start + (end - start) * progress;
}

function sameStrings(left: readonly string[], right: readonly string[]) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
