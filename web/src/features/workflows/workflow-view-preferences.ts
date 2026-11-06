import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { ViewportTransform } from "@/features/canvas/types";

export type WorkflowViewPreferences = { viewport: ViewportTransform; backgroundMode: CanvasBackgroundMode; showImageInfo: boolean };
export const defaultWorkflowView: WorkflowViewPreferences = { viewport: { x: 80, y: 80, k: 0.8 }, backgroundMode: "lines", showImageInfo: false };
const key = (owner: string, workflowId: string) => `workflow:view:${JSON.stringify([owner, workflowId])}`;
export function readWorkflowView(storage: Pick<Storage, "getItem">, owner: string, workflowId: string): WorkflowViewPreferences {
    try {
        const value = JSON.parse(storage.getItem(key(owner, workflowId)) || "null");
        const v = value?.viewport;
        if (!v || ![v.x, v.y, v.k].every(Number.isFinite) || v.k < 0.05 || v.k > 5) return defaultWorkflowView;
        return { viewport: { x: v.x, y: v.y, k: v.k }, backgroundMode: ["lines", "dots", "blank"].includes(value.backgroundMode) ? value.backgroundMode : "lines", showImageInfo: value.showImageInfo === true };
    } catch {
        return defaultWorkflowView;
    }
}
export function writeWorkflowView(storage: Pick<Storage, "setItem">, owner: string, workflowId: string, value: WorkflowViewPreferences) {
    try {
        storage.setItem(key(owner, workflowId), JSON.stringify(value));
    } catch {
        /* View preferences are optional; the workflow document is saved independently. */
    }
}
