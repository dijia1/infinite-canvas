import { CanvasNodeType, type CanvasNodeData } from "../types";

// Below this zoom the card's 11px labels render under 9px, so it switches to compact controls.
export const CONFIG_COMPACT_MAX_SCALE = 0.8;

// Smallest on-screen sizes that keep the compact tiers usable: three control rows, or two icons.
const CONTROLS_FLOOR = { width: 136, height: 102 };
const ICONS_FLOOR = { width: 68, height: 40 };

type Floor = typeof CONTROLS_FLOOR;
type CardGeometry = Pick<CanvasNodeData, "position" | "width" | "height">;

export type ConfigCardFloorLimits = { controls: number; icons: number };

function floorScale(node: CardGeometry, floor: Floor) {
    return Math.max(floor.width / node.width, floor.height / node.height);
}

// Two floored cards stay apart once their screen distance on either axis covers their combined half sizes,
// so each card's limit is the lowest zoom that holds against every other config card.
function lowestZoomForFloor(node: CanvasNodeData, cards: CanvasNodeData[], floor: Floor) {
    const scale = floorScale(node, floor);
    const centerX = node.position.x + node.width / 2;
    const centerY = node.position.y + node.height / 2;
    let limit = 0;
    for (const other of cards) {
        if (other === node) continue;
        const otherScale = floorScale(other, floor);
        const dx = Math.abs(other.position.x + other.width / 2 - centerX);
        const dy = Math.abs(other.position.y + other.height / 2 - centerY);
        const zoomForX = dx ? (node.width * scale + other.width * otherScale) / 2 / dx : Infinity;
        const zoomForY = dy ? (node.height * scale + other.height * otherScale) / 2 / dy : Infinity;
        limit = Math.max(limit, Math.min(zoomForX, zoomForY));
    }
    return limit;
}

export function getConfigCardFloorLimits(nodes: CanvasNodeData[]) {
    const cards = nodes.filter((node) => node.type === CanvasNodeType.Config);
    return new Map<string, ConfigCardFloorLimits>(cards.map((node) => [node.id, { controls: lowestZoomForFloor(node, cards, CONTROLS_FLOOR), icons: lowestZoomForFloor(node, cards, ICONS_FLOOR) }]));
}

// The card's minimum screen scale at this zoom, or 0 when it has to keep shrinking with the canvas.
export function getConfigCardFloorScale(node: CardGeometry, zoom: number, limits: ConfigCardFloorLimits | undefined) {
    if (!limits) return 0;
    if (zoom >= limits.controls) return floorScale(node, CONTROLS_FLOOR);
    if (zoom >= limits.icons) return floorScale(node, ICONS_FLOOR);
    return 0;
}

// How much larger than its world size the card currently renders.
export function getConfigCardDisplayScale(node: CardGeometry, zoom: number, limits: ConfigCardFloorLimits | undefined) {
    return Math.max(1, getConfigCardFloorScale(node, zoom, limits) / zoom);
}
