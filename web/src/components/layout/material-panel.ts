export type MaterialPanel = "my-assets" | "public-assets" | null;

export function toggleMaterialPanel(current: MaterialPanel, target: Exclude<MaterialPanel, null>): MaterialPanel {
    return current === target ? null : target;
}
