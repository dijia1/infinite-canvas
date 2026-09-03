export type CanvasImageVariant = "thumbnail" | "original" | "none";
export type CanvasRenderDetail = "overview" | "full";

type CanvasImageVariantOptions = {
    visible: boolean;
    width: number;
    height: number;
    scale: number;
    pinned?: boolean;
    currentVariant?: Exclude<CanvasImageVariant, "none">;
};

// These are screen-space, not zoom-space, thresholds. The gap retains the
// current variant around a boundary so continuous zooming does not thrash URLs.
const THUMBNAIL_MAX_SCREEN_EDGE = 192;
const ORIGINAL_MIN_SCREEN_EDGE = 256;
const OVERVIEW_MAX_SCALE = 0.3;

export function getCanvasRenderDetail(scale: number): CanvasRenderDetail {
    return scale <= OVERVIEW_MAX_SCALE ? "overview" : "full";
}

export function getCanvasImageVariant({ visible, width, height, scale, pinned = false, currentVariant }: CanvasImageVariantOptions): CanvasImageVariant {
    if (pinned) return "original";
    if (!visible) return "none";

    const screenEdge = Math.max(0, width * scale, height * scale);
    if (screenEdge >= ORIGINAL_MIN_SCREEN_EDGE) return "original";
    if (screenEdge <= THUMBNAIL_MAX_SCREEN_EDGE) return "thumbnail";
    return currentVariant || "thumbnail";
}
