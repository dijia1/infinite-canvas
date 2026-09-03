export type CanvasImageVariant = "thumbnail" | "original" | "none";

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
const THUMBNAIL_MAX_SCREEN_EDGE = 480;
const ORIGINAL_MIN_SCREEN_EDGE = 640;

export function getCanvasImageVariant({ visible, width, height, scale, pinned = false, currentVariant }: CanvasImageVariantOptions): CanvasImageVariant {
    if (!visible) return "none";
    if (pinned) return "original";

    const screenEdge = Math.max(0, width * scale, height * scale);
    if (screenEdge >= ORIGINAL_MIN_SCREEN_EDGE) return "original";
    if (screenEdge <= THUMBNAIL_MAX_SCREEN_EDGE) return "thumbnail";
    return currentVariant || "thumbnail";
}
