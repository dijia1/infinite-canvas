import type { CanvasNodeData, Position } from "../types";

export function getConnectionCurve(from: CanvasNodeData, to: CanvasNodeData) {
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const dx = Math.abs(endX - startX);
    const curvature = Math.max(dx * 0.5, 50);

    return {
        start: { x: startX, y: startY },
        control1: { x: startX + curvature, y: startY },
        control2: { x: endX - curvature, y: endY },
        end: { x: endX, y: endY },
        pathD: `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`,
    };
}

export function distanceBetweenPoints(a: Position, b: Position) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function cubicBezierPoint(start: Position, control1: Position, control2: Position, end: Position, t: number): Position {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;

    return {
        x: mt2 * mt * start.x + 3 * mt2 * t * control1.x + 3 * mt * t2 * control2.x + t2 * t * end.x,
        y: mt2 * mt * start.y + 3 * mt2 * t * control1.y + 3 * mt * t2 * control2.y + t2 * t * end.y,
    };
}

export function sampleConnectionPoints(from: CanvasNodeData, to: CanvasNodeData, steps = 24) {
    const curve = getConnectionCurve(from, to);
    return Array.from({ length: steps + 1 }, (_, index) => cubicBezierPoint(curve.start, curve.control1, curve.control2, curve.end, index / steps));
}

function pointToSegmentDistance(point: Position, segmentStart: Position, segmentEnd: Position) {
    const dx = segmentEnd.x - segmentStart.x;
    const dy = segmentEnd.y - segmentStart.y;
    if (dx === 0 && dy === 0) return distanceBetweenPoints(point, segmentStart);
    const t = Math.max(0, Math.min(1, ((point.x - segmentStart.x) * dx + (point.y - segmentStart.y) * dy) / (dx * dx + dy * dy)));
    return distanceBetweenPoints(point, { x: segmentStart.x + dx * t, y: segmentStart.y + dy * t });
}

function orientation(a: Position, b: Position, c: Position) {
    const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
    if (Math.abs(value) < 0.0001) return 0;
    return value > 0 ? 1 : 2;
}

function onSegment(a: Position, b: Position, c: Position) {
    return b.x <= Math.max(a.x, c.x) && b.x >= Math.min(a.x, c.x) && b.y <= Math.max(a.y, c.y) && b.y >= Math.min(a.y, c.y);
}

function segmentsIntersect(startA: Position, endA: Position, startB: Position, endB: Position) {
    const o1 = orientation(startA, endA, startB);
    const o2 = orientation(startA, endA, endB);
    const o3 = orientation(startB, endB, startA);
    const o4 = orientation(startB, endB, endA);
    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSegment(startA, startB, endA)) return true;
    if (o2 === 0 && onSegment(startA, endB, endA)) return true;
    if (o3 === 0 && onSegment(startB, startA, endB)) return true;
    if (o4 === 0 && onSegment(startB, endA, endB)) return true;
    return false;
}

function segmentDistance(startA: Position, endA: Position, startB: Position, endB: Position) {
    if (segmentsIntersect(startA, endA, startB, endB)) return 0;
    return Math.min(pointToSegmentDistance(startA, startB, endB), pointToSegmentDistance(endA, startB, endB), pointToSegmentDistance(startB, startA, endA), pointToSegmentDistance(endB, startA, endA));
}

export function segmentHitsConnection(cutStart: Position, cutEnd: Position, from: CanvasNodeData, to: CanvasNodeData, threshold: number) {
    const points = sampleConnectionPoints(from, to);
    for (let index = 1; index < points.length; index += 1) {
        if (segmentDistance(cutStart, cutEnd, points[index - 1], points[index]) <= threshold) return true;
    }
    return false;
}
