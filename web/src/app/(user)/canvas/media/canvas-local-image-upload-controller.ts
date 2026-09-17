import type { UserImageUploadOptions } from "@/services/api/image";
import type { UploadedImage } from "@/services/image-storage";

export type LocalImageUploadIntent = "canvas" | "library";

type UploadedRemoteImage = {
    mediaId: string;
    url: string;
    mediaExpiresAt?: string;
};

type LocalImageUploadTask = {
    nodeId: string;
    file: File;
    image: UploadedImage;
    intent: LocalImageUploadIntent;
    scope?: string;
};

type CanvasLocalImageUploadControllerOptions = {
    upload: (file: File, intent: LocalImageUploadIntent, options: UserImageUploadOptions) => Promise<UploadedRemoteImage>;
    promote: (image: UploadedImage, mediaId: string) => Promise<UploadedImage>;
    onProgress: (nodeId: string, progress: number, source: LocalImageUploadTask) => void;
    onCompleted: (nodeId: string, image: UploadedImage, remote: UploadedRemoteImage, source: LocalImageUploadTask) => void;
    onFailed: (nodeId: string, error: string, source: LocalImageUploadTask) => void;
};

function isUploadAbort(error: unknown) {
    return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

// Limit requests here, not in the local-file reader: retries and recovery use this queue too.
const MAX_UPLOADS = 3;

export function createCanvasLocalImageUploadController(options: CanvasLocalImageUploadControllerOptions) {
    type Entry = { source: LocalImageUploadTask; controller: AbortController; finish: () => void; running: boolean };
    const active = new Map<string, Entry>();
    const queue: Entry[] = [];
    let running = 0;
    const isCurrent = (entry: Entry) => active.get(entry.source.nodeId) === entry && !entry.controller.signal.aborted;

    const cancel = (nodeId: string) => {
        const entry = active.get(nodeId);
        if (!entry) return;
        active.delete(nodeId);
        entry.controller.abort();
        if (!entry.running) {
            const index = queue.indexOf(entry);
            if (index >= 0) queue.splice(index, 1);
            entry.finish();
        }
    };
    const run = async (entry: Entry) => {
        const { source, controller } = entry;
        const { nodeId, file, image, intent } = source;
        try {
            const remote = await options.upload(file, intent, {
                signal: controller.signal,
                onProgress: progress => { if (isCurrent(entry)) options.onProgress(nodeId, progress, source); },
            });
            if (!isCurrent(entry)) return;
            const promoted = await options.promote(image, remote.mediaId);
            if (!isCurrent(entry)) return;
            options.onCompleted(nodeId, promoted, remote, source);
        } catch (error) {
            if (isCurrent(entry) && !isUploadAbort(error)) options.onFailed(nodeId, error instanceof Error ? error.message : "上传图片失败", source);
        } finally {
            if (active.get(nodeId) === entry) active.delete(nodeId);
            // Aborting a request is not proof it has stopped. Release its slot only on settlement.
            running--;
            drain();
            entry.finish();
        }
    };
    const drain = () => {
        while (running < MAX_UPLOADS && queue.length) {
            const entry = queue.shift()!;
            entry.running = true;
            running++;
            void run(entry);
        }
    };
    return {
        start: (source: LocalImageUploadTask) => {
            cancel(source.nodeId);
            return new Promise<void>(finish => {
                const entry: Entry = { source, controller: new AbortController(), finish, running: false };
                active.set(source.nodeId, entry);
                queue.push(entry);
                drain();
            });
        },
        cancel,
        isActive: (nodeId: string) => active.has(nodeId),
        dispose: () => { for (const nodeId of [...active.keys()]) cancel(nodeId); },
    };
}
