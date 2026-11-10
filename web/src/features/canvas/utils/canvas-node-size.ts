"use client";

export function fitNodeSize(width: number, height: number, maxWidth = 640, maxHeight = 640) {
    const w = Number.isFinite(width) && width > 0 ? width : maxWidth;
    const h = Number.isFinite(height) && height > 0 ? height : maxHeight;
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    return { width: w * scale, height: h * scale };
}

export function nodeSizeFromRatio(size: string, baseWidth: number, baseHeight: number) {
    const match = size?.match(/^(\d+)(?:x|:)(\d+)/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const ratio = width / Math.max(1, height);
    if (ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
    return ratio >= baseWidth / baseHeight ? { width: baseWidth, height: baseWidth / ratio } : { width: baseHeight * ratio, height: baseHeight };
}

// Give native video controls enough layout width, including portrait videos.
export function videoNodeSize(dimensions: { width: number; height: number }) {
    const width = dimensions.width < dimensions.height ? 360 : 420;
    return { width, height: width * dimensions.height / dimensions.width };
}

export function fitVideoNode<T extends { width?: number; height?: number; position?: { x: number; y: number } }>(node: T, dimensions: { width: number; height: number }, force = false, placeholderRatio?: string): T {
    const width = node.width || 420;
    const height = node.height || 236;
    const size = videoNodeSize(dimensions);
    if (width === size.width && height === size.height) return node;
    const placeholder = placeholderRatio ? nodeSizeFromRatio(placeholderRatio, 420, 236) : null;
    const automatic = [
        { width: 420, height: 236 },
        fitNodeSize(dimensions.width, dimensions.height, 420, 420),
        nodeSizeFromRatio(`${dimensions.width}:${dimensions.height}`, 420, 236),
        placeholder,
        placeholder ? videoNodeSize(placeholder) : null,
        size,
    ];
    // Existing custom geometry is the resize source of truth; only replace old automatic layouts.
    if (!force && !automatic.some((value) => value && Math.abs(width - value.width) <= 1 && Math.abs(height - value.height) <= 1)) return node;
    return { ...node, ...size, ...(node.position ? { position: { x: node.position.x + (width - size.width) / 2, y: node.position.y + (height - size.height) / 2 } } : {}) };
}
