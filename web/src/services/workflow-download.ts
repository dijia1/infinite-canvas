import { appApiPath } from "@/lib/app-path";
import { apiGet } from "./api/request";

const pendingDownloads = new Set<string>();
export async function downloadWorkflowImages(runId: string, signal?: AbortSignal) {
    if (pendingDownloads.has(runId)) return;
    pendingDownloads.add(runId);
    try {
        const path = `/api/v1/workflow-runs/${encodeURIComponent(runId)}/images/download`;
        const result = await apiGet<{ count: number; filename: string }>(path, { check: "1" }, undefined, { timeout: 120_000, signal });
        signal?.throwIfAborted();
        if (!result.count) throw new Error("当前运行没有可下载的成功图片");
        const frame = document.createElement("iframe");
        frame.hidden = true;
        frame.title = "工作流图片下载";
        frame.src = appApiPath(path);
        document.body.appendChild(frame);
        // Keep the download target alive beyond the server's bounded stream time.
        setTimeout(() => frame.remove(), 11 * 60_000);
        return result.count;
    } finally {
        pendingDownloads.delete(runId);
    }
}
