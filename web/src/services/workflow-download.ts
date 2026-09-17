import { saveAs } from "file-saver";
import { getImageBlob, loadMediaImage, resolveRemoteImage } from "./image-storage";
import type { WorkflowImageDownloadTarget } from "@/features/workflows/workflow-image-download";
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

// Always resolve the original variant; a displayed overview URL can be a thumbnail.
export async function downloadSelectedWorkflowImages(targets: readonly WorkflowImageDownloadTarget[], signal: AbortSignal) {
    const snapshot = targets.map(target => ({ ...target }));
    let saved = 0, failed = 0;
    for (const target of snapshot) {
        signal.throwIfAborted();
        try {
            const image = await loadMediaImage(target.mediaId, () => resolveRemoteImage(target.mediaId), { signal });
            const blob = await getImageBlob(image.storageKey);
            signal.throwIfAborted();
            if (!blob) throw new Error("图片原图缓存不可用");
            const mime = (blob.type || image.mimeType).toLowerCase().split(";")[0]!;
            const extension = mime === "image/jpeg" ? "jpg" : mime.replace(/^image\//, "").replace(/\+xml$/, "");
            if (!mime.startsWith("image/") || !/^[a-z0-9]+$/.test(extension)) throw new Error("无法识别图片格式");
            saveAs(blob, `${target.filename}.${extension}`);
            saved++;
        } catch (error) {
            if (signal.aborted) throw error;
            failed++;
        }
    }
    return { saved, failed };
}
