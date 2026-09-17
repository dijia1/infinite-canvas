import { parseWorkflowVisualId } from "./workflow-canvas-adapter";
import { workflowOutputKey } from "./workflow-run-state";
import type { WorkflowGraph, WorkflowOutputExecution } from "./types";

export type WorkflowImageDownloadTarget = { mediaId: string; filename: string };
export type WorkflowImageMenu = { x: number; y: number; selectedIds: ReadonlySet<string> };

export function workflowImageMenuSelection(selected: ReadonlySet<string>, clicked: string): Set<string> {
    return selected.has(clicked) ? new Set(selected) : new Set([clicked]);
}

export function workflowImageDownloadState(graph: WorkflowGraph, selected: ReadonlySet<string>, outputs: ReadonlyMap<string, WorkflowOutputExecution>, nodeRunIds: Readonly<Record<string, string>> | undefined, loadedRunIds: ReadonlySet<string>) {
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const targets: WorkflowImageDownloadTarget[] = [];
    const pendingRunIds = new Set<string>();
    let pendingOverview = false;
    for (const id of selected) {
        const visual = parseWorkflowVisualId(id);
        const node = visual && nodes.get(visual.nodeId);
        if (!node || !visual) continue;
        const filename = `workflow-image-${node.id}${visual.kind === "output" ? `-${visual.slotId}` : ""}`.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
        if (visual.kind === "node") {
            if (node.type === "image_input" && node.mediaId) targets.push({ mediaId: node.mediaId, filename });
            continue;
        }
        if (!node.outputs?.some(slot => slot.id === visual.slotId && slot.type === "image")) continue;
        if (!nodeRunIds) { pendingOverview = true; continue; }
        const runId = nodeRunIds[node.id];
        if (!runId) continue;
        if (!loadedRunIds.has(runId)) { pendingRunIds.add(runId); continue; }
        const output = outputs.get(workflowOutputKey(node.id, visual.slotId));
        if (output?.status === "succeeded" && output.mediaId && output.runId === runId) targets.push({ mediaId: output.mediaId, filename });
    }
    return { targets, pendingRunIds: [...pendingRunIds], pendingOverview };
}
