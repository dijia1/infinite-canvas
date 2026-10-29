import { saveAs } from "file-saver";
import { appApiPath } from "@/lib/app-path";
import { fetchPublicImageAccess } from "./api/public-images";
import { imageBlobFromResponse } from "./image-blob";
import { getImageBlob, imageStorageKeyForMedia, loadMediaImage, mediaIdFromImageStorageKey, resolveRemoteImage } from "./image-storage";

export type ImageDownloadTarget = { filename: string; mediaId?: string; storageKey?: string; url?: string; publicImageId?: string; mimeType?: string };
export type ImageDownloadState = {
    phase: "reading" | "waiting" | "completed" | "cancelled";
    total: number;
    processed: number;
    issued: number;
    failed: number;
    currentFilename?: string;
    error?: string;
};

export async function readImageDownload(target: ImageDownloadTarget, signal: AbortSignal): Promise<Blob> {
    if (target.storageKey) {
        const cachedMediaId = mediaIdFromImageStorageKey(target.storageKey);
        const cached = await getImageBlob(cachedMediaId ? imageStorageKeyForMedia(cachedMediaId) : target.storageKey);
        if (cached) return cached;
    }
    if (target.url) return imageBlobFromResponse(await fetch(appApiPath(target.url), { signal }));
    const mediaId = target.mediaId || mediaIdFromImageStorageKey(target.storageKey);
    if (mediaId) {
        const image = await loadMediaImage(mediaId, () => resolveRemoteImage(mediaId), { signal });
        const blob = await getImageBlob(image.storageKey);
        if (blob) return blob;
    } else if (target.publicImageId) {
        const id = target.publicImageId;
        const access = await fetchPublicImageAccess(id, signal);
        signal.throwIfAborted();
        const image = await loadMediaImage(access.mediaId, access.url, { signal });
        const blob = await getImageBlob(image.storageKey);
        if (blob) return blob;
    }
    throw new Error("图片原图不可用");
}

function imageDownloadFilename(target: ImageDownloadTarget, blob: Blob) {
    const mime = (blob.type || target.mimeType || "").toLowerCase().split(";")[0]!.trim();
    const extension = mime === "image/jpeg" ? "jpg" : mime.replace(/^image\//, "").replace(/\+xml$/, "");
    if (!mime.startsWith("image/") || !/^[a-z0-9]+$/.test(extension)) throw new Error("无法识别图片格式");
    return `${target.filename}.${extension}`;
}

function waitForDownload(ms: number, signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
        signal.addEventListener("abort", abort, { once: true });
    });
}

export function createImageDownloadQueue({ read = readImageDownload, save = saveAs, now = () => performance.now(), wait = waitForDownload }: {
    read?: (target: ImageDownloadTarget, signal: AbortSignal) => Promise<Blob>;
    save?: (blob: Blob, filename: string) => void;
    now?: () => number;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
} = {}) {
    let state: ImageDownloadState | null = null;
    let controller: AbortController | null = null;
    let lastIssued = -Infinity;
    let failedTargets: ImageDownloadTarget[] = [];
    const listeners = new Set<() => void>();
    const notify = () => listeners.forEach(listener => listener());
    const publish = (patch: Partial<ImageDownloadState>) => { state = { ...state!, ...patch }; notify(); };

    const start = async (targets: readonly ImageDownloadTarget[]) => {
        if (controller || !targets.length) return false;
        const snapshot = targets.map(target => ({ ...target }));
        const current = new AbortController(); controller = current; failedTargets = [];
        state = { phase: "reading", total: snapshot.length, processed: 0, issued: 0, failed: 0 }; notify();
        try {
            for (const target of snapshot) {
                current.signal.throwIfAborted();
                publish({ phase: "reading", currentFilename: target.filename });
                try {
                    const blob = await read(target, current.signal);
                    current.signal.throwIfAborted();
                    const filename = imageDownloadFilename(target, blob);
                    publish({ phase: "waiting" });
                    // Serial reads alone do not pace cached images. Delay the actual
                    // browser save, including retries and consecutive batches.
                    const remaining = 200 - (now() - lastIssued);
                    if (remaining > 0) await wait(Math.ceil(remaining) + 1, current.signal);
                    current.signal.throwIfAborted();
                    save(blob, filename); lastIssued = now();
                    publish({ processed: state!.processed + 1, issued: state!.issued + 1 });
                } catch (error) {
                    if (current.signal.aborted) throw error;
                    failedTargets.push(target);
                    publish({ processed: state!.processed + 1, failed: state!.failed + 1, error: `${target.filename}：${error instanceof Error ? error.message : "图片读取失败"}` });
                }
            }
            controller = null; publish({ phase: "completed", currentFilename: undefined });
        } catch (error) {
            controller = null;
            if (!current.signal.aborted) throw error;
            publish({ phase: "cancelled", currentFilename: undefined });
        }
        return true;
    };
    return {
        start,
        retry: () => start(failedTargets),
        cancel: () => controller?.abort(),
        dismiss: () => { if (!controller) { state = null; failedTargets = []; notify(); } },
        getSnapshot: () => state,
        isBusy: () => controller !== null,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
}
export type ImageDownloadQueue = ReturnType<typeof createImageDownloadQueue>;
