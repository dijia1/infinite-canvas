type CanvasViewportSize = {
    width: number;
    height: number;
};

export function getCanvasViewportSize(container: Pick<HTMLElement, "getBoundingClientRect"> | null, fallback: CanvasViewportSize): CanvasViewportSize {
    const rect = container?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : fallback;
}
