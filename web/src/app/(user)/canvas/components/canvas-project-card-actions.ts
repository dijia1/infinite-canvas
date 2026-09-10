import type { CanvasSummary } from "@/services/api/canvas-projects";
import { selectCanvasProjectSummaries, type CanvasProject, type CanvasProjectSync, type CanvasStore } from "../stores/use-canvas-store";
import { hasLocalImageUploads } from "../utils/canvas-local-image-upload";

type CanvasProjectCardState = Pick<CanvasStore, "syncScope" | "summaries" | "projects" | "projectSync" | "summariesLoaded">;

export function describeCanvasSummaryCounts(summary: CanvasSummary) {
    return `${summary.nodeCount} 个节点 · ${summary.connectionCount} 条连线`;
}

export async function loadCanvasProjectForCardAction({ id, revalidate = false, ensureProjectDetail, readState }: { id: string; revalidate?: boolean; ensureProjectDetail: CanvasStore["ensureProjectDetail"]; readState: () => CanvasProjectCardState }) {
    const scope = readState().syncScope;
    await ensureProjectDetail(id, { revalidate });
    const state = readState();
    const project = state.projects.find((item) => item.id === id);
    const summary = selectCanvasProjectSummaries(state).find((item) => item.id === id);
    if (state.syncScope !== scope || !project || !summary) throw new Error("画布操作已失效，请重试");
    return { project, summary, sync: state.projectSync[id] };
}

export function createCanvasProjectCardActionGate() {
    let running = false;
    return {
        run: async (action: () => Promise<void> | void) => {
            if (running) return false;
            running = true;
            try {
                await action();
                return true;
            } finally {
                running = false;
            }
        },
    };
}

export function shareCanvasProjectStatus(project: Pick<CanvasProject, "nodes"> | null, sync?: CanvasProjectSync): { allowed: true; revision: number } | { allowed: false; reason: string } {
    if (project && hasLocalImageUploads(project.nodes)) return { allowed: false, reason: "请等待本地图片上传完成后再分享" };
    if (typeof sync?.serverRevision !== "number" || sync.dirty || sync.pending || sync.saving || sync.conflict || sync.unknownRequest) return { allowed: false, reason: "等待画布保存后再分享" };
    return { allowed: true, revision: sync.serverRevision };
}
