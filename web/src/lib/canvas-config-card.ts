// World-space resize limits are shared by all forms; zoom only changes their presentation.
export const CONFIG_NODE_MIN_SIZE = { width: 360, height: 274 };

// Below this zoom the card's 11px labels render under 9px, so it switches to compact controls.
export const CONFIG_COMPACT_MAX_SCALE = 0.8;
// Below this zoom the compact controls are too small to read, so only the settings and action icons remain.
export const CONFIG_ICONS_MAX_SCALE = 0.19;

// The on-screen size each form's layout in globals.css is designed to fit.
const CONTROLS_DESIGN_SIZE = { width: 176, height: 134 };
const ICONS_DESIGN_SIZE = { width: 68, height: 40 };

// designScale is the node scale the form's layout is drawn at. It depends only on the node's size, so the
// layout scales with the card and never reflows while zooming.
export type ConfigCardView = { form: "controls" | "icons"; designScale: number };

export function getConfigCardView(node: { width: number; height: number }, zoom: number): ConfigCardView {
    const form = zoom < CONFIG_ICONS_MAX_SCALE ? "icons" : "controls";
    const size = form === "icons" ? ICONS_DESIGN_SIZE : CONTROLS_DESIGN_SIZE;
    return { form, designScale: Math.max(size.width / node.width, size.height / node.height) };
}
