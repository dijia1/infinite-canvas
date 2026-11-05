import { CanvasNodeType, type CanvasNodeData } from "../types";

// Below this zoom the card's 11px labels render under 9px, so it switches to compact controls.
export const CONFIG_COMPACT_MAX_SCALE = 0.8;

// Smallest on-screen size of each compact form. Their layouts in globals.css are designed to fit exactly these sizes.
const CONTROLS_FLOOR = { width: 176, height: 134 };
const ICONS_FLOOR = { width: 68, height: 40 };

type Floor = typeof CONTROLS_FLOOR;
type CardGeometry = Pick<CanvasNodeData, "position" | "width" | "height">;

export type ConfigCardFloorLimits = { controls: number; icons: number };

// designScale is the node scale the form's layout is drawn at. floorScale is the lowest screen scale the card
// may reach, or 0 once it has to keep shrinking with the canvas.
export type ConfigCardView = { form: "controls" | "icons"; designScale: number; floorScale: number };

function scaleForFloor(node: CardGeometry, floor: Floor) {
    return Math.max(floor.width / node.width, floor.height / node.height);
}

// Two floored cards stay apart once their screen distance on either axis covers their combined half sizes,
// so each card's limit is the lowest zoom that holds against every other config card.
function lowestZoomForFloor(node: CanvasNodeData, cards: CanvasNodeData[], floor: Floor) {
    const scale = scaleForFloor(node, floor);
    const centerX = node.position.x + node.width / 2;
    const centerY = node.position.y + node.height / 2;
    let limit = 0;
    for (const other of cards) {
        if (other === node) continue;
        const otherScale = scaleForFloor(other, floor);
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

export function getConfigCardView(node: CardGeometry, zoom: number, limits: ConfigCardFloorLimits | undefined): ConfigCardView | undefined {
    if (!limits) return undefined;
    if (zoom >= limits.controls) {
        const scale = scaleForFloor(node, CONTROLS_FLOOR);
        return { form: "controls", designScale: scale, floorScale: scale };
    }
    const scale = scaleForFloor(node, ICONS_FLOOR);
    return { form: "icons", designScale: scale, floorScale: zoom >= limits.icons ? scale : 0 };
}

// How much larger than its world size the card currently renders.
export function getConfigCardDisplayScale(node: CardGeometry, zoom: number, limits: ConfigCardFloorLimits | undefined) {
    if (zoom >= CONFIG_COMPACT_MAX_SCALE) return 1;
    return Math.max(1, (getConfigCardView(node, zoom, limits)?.floorScale ?? 0) / zoom);
}
