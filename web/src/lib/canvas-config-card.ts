// World-space resize limits are shared by all forms; zoom only changes their presentation.
export const CONFIG_NODE_MIN_SIZE = { width: 360, height: 274 };

// Below this zoom the card's 11px labels render under 9px, so it switches to compact controls.
export const CONFIG_COMPACT_MAX_SCALE = 0.8;

// The compact layout size in globals.css.
const CONTROLS_DESIGN_SIZE = { width: 176, height: 134 };

// The layout scales with the node size and never reflows while zooming.
export type ConfigCardView = { designScale: number };

export function getConfigCardView(node: { width: number; height: number }): ConfigCardView {
    return { designScale: Math.max(CONTROLS_DESIGN_SIZE.width / node.width, CONTROLS_DESIGN_SIZE.height / node.height) };
}
