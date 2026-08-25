import type { ImageMask, ImageMaskPoint, ImageMaskStroke } from "@/types/image";

const MAX_RADIUS = 0.5;
const MIN_RADIUS = 0.0005;

export function normalizeImageMask(value: unknown): ImageMask | undefined {
    if (!value || typeof value !== "object") return undefined;
    const item = value as { version?: unknown; strokes?: unknown };
    if (item.version !== 1 || !Array.isArray(item.strokes)) return undefined;
    const strokes = item.strokes.map(normalizeMaskStroke).filter((stroke): stroke is ImageMaskStroke => Boolean(stroke));
    return strokes.length ? { version: 1, strokes } : undefined;
}

export function appendMaskStroke(mask: ImageMask | undefined, stroke: ImageMaskStroke): ImageMask {
    const normalized = normalizeMaskStroke(stroke);
    return { version: 1, strokes: [...(normalizeImageMask(mask)?.strokes || []), ...(normalized ? [normalized] : [])] };
}

export function hasImageMask(mask: ImageMask | undefined): boolean {
    return Boolean(normalizeImageMask(mask)?.strokes.length);
}

export function drawImageMask(context: CanvasRenderingContext2D, mask: ImageMask | undefined, width: number, height: number, color: string) {
    context.clearRect(0, 0, width, height);
    const normalized = normalizeImageMask(mask);
    if (!normalized || width <= 0 || height <= 0) return;

    const basis = Math.min(width, height);
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of normalized.strokes) {
        const radius = stroke.radius * basis;
        context.globalCompositeOperation = stroke.tool === "erase" ? "destination-out" : "source-over";
        context.strokeStyle = color;
        context.fillStyle = color;
        context.lineWidth = radius * 2;
        const [first, ...rest] = stroke.points;
        if (!first) continue;
        if (!rest.length) {
            context.beginPath();
            context.arc(first.x * width, first.y * height, radius, 0, Math.PI * 2);
            context.fill();
            continue;
        }
        context.beginPath();
        context.moveTo(first.x * width, first.y * height);
        for (const point of rest) context.lineTo(point.x * width, point.y * height);
        context.stroke();
    }
    context.restore();
}

export function clampMaskPoint(point: ImageMaskPoint): ImageMaskPoint {
    return { x: clamp(Number(point.x) || 0, 0, 1), y: clamp(Number(point.y) || 0, 0, 1) };
}

function normalizeMaskStroke(value: unknown): ImageMaskStroke | undefined {
    if (!value || typeof value !== "object") return undefined;
    const stroke = value as { id?: unknown; tool?: unknown; radius?: unknown; points?: unknown };
    if (typeof stroke.id !== "string" || !stroke.id || (stroke.tool !== "paint" && stroke.tool !== "erase") || !Array.isArray(stroke.points) || !stroke.points.length) return undefined;
    const points = stroke.points.filter((point): point is ImageMaskPoint => Boolean(point && typeof point === "object")).map((point) => clampMaskPoint(point));
    if (!points.length) return undefined;
    return { id: stroke.id, tool: stroke.tool, radius: clamp(Number(stroke.radius) || MIN_RADIUS, MIN_RADIUS, MAX_RADIUS), points };
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
