import { imageStorageKeyForMedia, type UploadedImage } from "@/services/image-storage";

import type { CanvasMediaLoadPriority, CanvasMediaLoadQueue, MediaLoadLease } from "./canvas-media-load-queue";

export type CanvasImageResource = Pick<UploadedImage, "url" | "storageKey" | "mediaId"> & {
    variant: "thumbnail" | "original";
};

export type CanvasImageResourceRequest = {
    nodeId: string;
    mediaId: string;
    variant: "thumbnail" | "original";
    priority: CanvasMediaLoadPriority;
    releaseOriginalAfterThumbnail?: boolean;
    loadThumbnail: (signal: AbortSignal) => Promise<UploadedImage>;
    loadOriginal: (signal: AbortSignal) => Promise<UploadedImage>;
};

type ResourceEntry = {
    request: CanvasImageResourceRequest;
    generation: number;
    current?: CanvasImageResource;
    retained: CanvasImageResource[];
    pending?: { variant: CanvasImageResourceRequest["variant"]; generation: number; lease: MediaLoadLease<UploadedImage> };
};

type CanvasImageResourceControllerOptions = {
    queue: CanvasMediaLoadQueue;
    releaseObjectURL: (storageKey: string) => void;
    deferRelease?: (release: () => void) => void;
    onChange?: () => void;
};

export type CanvasImageResourceController = {
    reconcile: (requests: CanvasImageResourceRequest[]) => void;
    get: (nodeId: string) => CanvasImageResource | undefined;
    snapshot: () => ReadonlyMap<string, CanvasImageResource>;
    acknowledgeRendered: (nodeId: string, storageKey: string) => void;
    dispose: () => void;
};

export function createCanvasImageResourceController({ queue, releaseObjectURL, deferRelease = (release) => setTimeout(release, 0), onChange }: CanvasImageResourceControllerOptions): CanvasImageResourceController {
    const entries = new Map<string, ResourceEntry>();
    let disposed = false;

    const notify = () => onChange?.();
    const hasResourceOwner = (storageKey: string) =>
        [...entries.values()].some(
            (entry) =>
                entry.current?.storageKey === storageKey ||
                entry.retained.some((resource) => resource.storageKey === storageKey) ||
                (entry.pending?.variant === "original" && imageStorageKeyForMedia(entry.request.mediaId) === storageKey),
        );
    const releaseIfUnused = (storageKey: string) => {
        deferRelease(() => {
            if (!hasResourceOwner(storageKey)) releaseObjectURL(storageKey);
        });
    };

    const releaseEntry = (entry: ResourceEntry) => {
        entry.generation += 1;
        entry.pending?.lease.release();
        entry.pending = undefined;
        if (entry.current) releaseIfUnused(entry.current.storageKey);
        entry.retained.forEach((resource) => releaseIfUnused(resource.storageKey));
        entry.retained = [];
    };

    const startLoad = (entry: ResourceEntry, request: CanvasImageResourceRequest) => {
        const generation = ++entry.generation;
        entry.pending?.lease.release();
        const loader = request.variant === "original" ? request.loadOriginal : request.loadThumbnail;
        const lease = queue.request({
            key: `canvas:${request.mediaId}:${request.variant}`,
            priority: request.priority,
            load: async (signal) => {
                const image = await loader(signal);
                if (disposed || entries.get(request.nodeId) !== entry || entry.generation !== generation) releaseIfUnused(image.storageKey);
                return image;
            },
        });
        entry.pending = { variant: request.variant, generation, lease };
        void lease.promise
            .then((image) => {
                if (disposed || entries.get(request.nodeId) !== entry || entry.generation !== generation || entry.pending?.generation !== generation) {
                    releaseIfUnused(image.storageKey);
                    return;
                }
                const previous = entry.current;
                entry.current = { url: image.url, storageKey: image.storageKey, mediaId: image.mediaId || request.mediaId, variant: request.variant };
                entry.pending = undefined;
                notify();
                if (previous && previous.storageKey !== image.storageKey && !entry.retained.some((resource) => resource.storageKey === previous.storageKey)) entry.retained.push(previous);
                const originalStorageKey = imageStorageKeyForMedia(request.mediaId);
                if (request.variant === "thumbnail" && request.releaseOriginalAfterThumbnail && image.storageKey !== originalStorageKey) releaseIfUnused(originalStorageKey);
            })
            .catch(() => {
                if (entries.get(request.nodeId) !== entry || entry.generation !== generation || entry.pending?.generation !== generation) return;
                entry.pending = undefined;
            });
    };

    const reconcile = (requests: CanvasImageResourceRequest[]) => {
        if (disposed) return;
        const nextByNodeID = new Map(requests.map((request) => [request.nodeId, request]));
        entries.forEach((entry, nodeId) => {
            if (nextByNodeID.has(nodeId)) return;
            entries.delete(nodeId);
            releaseEntry(entry);
            notify();
        });

        nextByNodeID.forEach((request, nodeId) => {
            const entry = entries.get(nodeId);
            if (!entry) {
                const created: ResourceEntry = { request, generation: 0, retained: [] };
                entries.set(nodeId, created);
                startLoad(created, request);
                return;
            }
            entry.request = request;
            if (entry.current?.variant === request.variant && !entry.pending) return;
            if (entry.pending?.variant === request.variant) return;
            startLoad(entry, request);
        });
    };

    return {
        reconcile,
        get: (nodeId) => entries.get(nodeId)?.current,
        snapshot: () => new Map([...entries].flatMap(([nodeId, entry]) => (entry.current ? [[nodeId, entry.current] as const] : []))),
        acknowledgeRendered: (nodeId, storageKey) => {
            const entry = entries.get(nodeId);
            if (!entry || entry.current?.storageKey !== storageKey || !entry.retained.length) return;
            const retained = entry.retained;
            entry.retained = [];
            retained.forEach((resource) => releaseIfUnused(resource.storageKey));
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            entries.forEach(releaseEntry);
            entries.clear();
            notify();
        },
    };
}
