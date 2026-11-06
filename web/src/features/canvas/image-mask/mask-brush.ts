export const DEFAULT_BRUSH_SIZE = 24;
export const MIN_BRUSH_SIZE = 8;
export const MAX_BRUSH_SIZE = 80;
const BRUSH_SIZE_STEP = 4;

// Match the normalized stroke radius limits used by mask-utils.
export function maskBrushRadius(size: number, width: number, height: number) {
    return Math.min(0.5, Math.max(0.0005, size / Math.max(1, Math.min(width, height)) / 2));
}

export function adjustMaskBrushSize(size: number, delta: number) {
    return Math.min(MAX_BRUSH_SIZE, Math.max(MIN_BRUSH_SIZE, size + delta));
}

export function maskBrushKeyDelta(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "isComposing">) {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return 0;
    if (event.key === "[" || event.code === "BracketLeft") return -BRUSH_SIZE_STEP;
    if (event.key === "]" || event.code === "BracketRight") return BRUSH_SIZE_STEP;
    return 0;
}
