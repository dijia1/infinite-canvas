import axios from "axios";
import { getVideoMediaAccess, VideoMediaRequestError, type VideoMediaAccess } from "@/services/api/video-media";
import { loadMediaThumbnailBlob } from "@/services/image-storage";
import { createCanvasMediaLoadQueue } from "./canvas-media-load-queue";

const aborted = () => new DOMException("视频资源加载已取消", "AbortError");
type Entry = {
    id: string;
    refs: number;
    lastUsed: number;
    access?: VideoMediaAccess;
    pending?: Promise<VideoMediaAccess>;
    accessAbort?: AbortController;
    posterPending?: Promise<string | undefined>;
    posterAbort?: AbortController;
    poster?: string;
    bytes: number;
    failedUntil: number;
    grace?: ReturnType<typeof setTimeout>;
    expiry?: ReturnType<typeof setTimeout>;
};
type Options = {
    loadAccess?: (id: string, signal: AbortSignal) => Promise<VideoMediaAccess>;
    loadPoster?: (url: string, signal: AbortSignal) => Promise<Blob>;
    cachePoster?: typeof loadMediaThumbnailBlob;
    createURL?: (blob: Blob) => string;
    revokeURL?: (url: string) => void;
    graceMs?: number;
    idleMs?: number;
    failureMs?: number;
    maxBytes?: number;
    maxEntries?: number;
};
export type VideoResourceLease = {
    getAccess: () => Promise<VideoMediaAccess>;
    refreshAfterFailure: (failedURL: string) => Promise<VideoMediaAccess>;
    getPoster: () => Promise<string | undefined>;
    release: () => void;
};

async function downloadPoster(url: string, signal: AbortSignal) {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) throw new Error("视频封面不可用");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("视频封面不可用");
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 2 * 1024 * 1024) throw new Error("视频封面超过大小限制");
            chunks.push(new Uint8Array(value));
        }
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
    const blob = new Blob(chunks, { type: response.headers.get("content-type")! });
    if (!blob.size) throw new Error("视频封面为空");
    // Reject corrupt image data before sharing it with every node.
    if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(blob);
        bitmap.close();
    }
    return blob;
}

export function createVideoResourceManager(options: Options = {}) {
    const entries = new Map<string, Entry>();
    const queue = createCanvasMediaLoadQueue({ concurrency: 4 });
    const loadAccess = options.loadAccess || getVideoMediaAccess;
    const createURL = options.createURL || ((blob: Blob) => URL.createObjectURL(blob));
    const revokeURL = options.revokeURL || ((url: string) => URL.revokeObjectURL(url));
    const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    const maxEntries = options.maxEntries ?? 128;
    let totalBytes = 0;
    const valid = (entry: Entry) => entries.get(entry.id) === entry;
    const remove = (entry: Entry) => {
        if (!valid(entry)) return;
        entries.delete(entry.id);
        clearTimeout(entry.grace);
        clearTimeout(entry.expiry);
        entry.accessAbort?.abort();
        entry.posterAbort?.abort();
        if (entry.poster) revokeURL(entry.poster);
        totalBytes -= entry.bytes;
    };
    const trim = (extra = 0) => {
        for (const entry of [...entries.values()].filter((e) => !e.refs).sort((a, b) => a.lastUsed - b.lastUsed)) {
            if (totalBytes + extra <= maxBytes && [...entries.values()].filter((e) => !e.refs).length <= maxEntries && (!extra || [...entries.values()].filter((e) => e.poster).length < maxEntries)) break;
            remove(entry);
        }
    };
    const resetSession = () => {
        for (const entry of [...entries.values()]) remove(entry);
    };
    const access = (entry: Entry, failedURL?: string): Promise<VideoMediaAccess> => {
        if (!valid(entry)) return Promise.reject(aborted());
        entry.lastUsed = Date.now();
        if (entry.pending) return entry.pending;
        const cached = entry.access;
        if (cached && Date.parse(cached.expiresAt || "") > Date.now() + 60000 && (!failedURL || cached.url !== failedURL)) return Promise.resolve(cached);
        const controller = new AbortController();
        entry.accessAbort = controller;
        const timeout = setTimeout(() => controller.abort(), 20000);
        const promise = (async () => {
            try {
                let value: VideoMediaAccess;
                try {
                    value = await loadAccess(entry.id, controller.signal);
                } catch (error) {
                    if (failedURL || controller.signal.aborted || !axios.isAxiosError(error) || (error.response && ![408, 429].includes(error.response.status) && error.response.status < 500)) throw error;
                    await new Promise<void>((resolve, reject) => {
                        const abort = () => {
                            clearTimeout(timer);
                            reject(aborted());
                        };
                        const timer = setTimeout(() => {
                            controller.signal.removeEventListener("abort", abort);
                            resolve();
                        }, 1000);
                        controller.signal.addEventListener("abort", abort, { once: true });
                        if (controller.signal.aborted) abort();
                    });
                    value = await loadAccess(entry.id, controller.signal);
                }
                if (!valid(entry) || controller.signal.aborted) throw aborted();
                entry.access = value;
                return value;
            } catch (error) {
                // Rejected access must never continue serving a cached private resource.
                if (valid(entry)) {
                    entry.access = undefined;
                    if (entry.poster && (error instanceof VideoMediaRequestError || (axios.isAxiosError(error) && [401, 403, 404].includes(error.response?.status || 0)))) {
                        revokeURL(entry.poster);
                        totalBytes -= entry.bytes;
                        entry.poster = undefined;
                        entry.bytes = 0;
                    }
                }
                throw error;
            } finally {
                clearTimeout(timeout);
            }
        })();
        entry.pending = promise;
        const settled = () => {
            if (entry.pending === promise) entry.pending = undefined;
        };
        void promise.then(settled, settled);
        return promise;
    };
    return {
        resetSession,
        dispose: resetSession,
        acquire(id: string): VideoResourceLease {
            let entry = entries.get(id);
            if (!entry) {
                entry = { id, refs: 0, lastUsed: Date.now(), bytes: 0, failedUntil: 0 };
                entries.set(id, entry);
            }
            const current = entry;
            current.refs++;
            clearTimeout(current.grace);
            clearTimeout(current.expiry);
            let released = false;
            return {
                getAccess: () => access(current),
                refreshAfterFailure: (url) => access(current, url),
                getPoster: () => {
                    if (!valid(current)) return Promise.reject(aborted());
                    if (current.poster) return Promise.resolve(current.poster);
                    if (current.posterPending) return current.posterPending;
                    if (current.failedUntil > Date.now()) return Promise.resolve(undefined);
                    const controller = new AbortController();
                    current.posterAbort = controller;
                    const pending = (async () => {
                        try {
                            const value = await access(current);
                            const blob = await (options.cachePoster || loadMediaThumbnailBlob)(current.id, async () => {
                                const url = value.previewUrl;
                                if (!url || url === value.url || !new URL(url, "http://localhost").searchParams.get("x-oss-process")?.startsWith("video/snapshot")) throw new Error("视频封面不可用");
                                const job = queue.request({
                                    key: current.id,
                                    priority: "visible-thumbnail",
                                    signal: controller.signal,
                                    load: async (signal) => {
                                        const timeout = setTimeout(() => controller.abort(), 15000);
                                        try {
                                            return await (options.loadPoster || downloadPoster)(url, signal);
                                        } finally {
                                            clearTimeout(timeout);
                                        }
                                    },
                                });
                                try {
                                    return await job.promise;
                                } finally {
                                    job.release();
                                }
                            }, { signal: controller.signal });
                            if (!valid(current) || controller.signal.aborted) throw aborted();
                            trim(blob.size);
                            if (blob.size > 2 * 1024 * 1024 || totalBytes + blob.size > maxBytes || [...entries.values()].filter((e) => e.poster).length >= maxEntries) return undefined;
                            current.poster = createURL(blob);
                            current.bytes = blob.size;
                            totalBytes += blob.size;
                            return current.poster;
                        } catch (error) {
                            if (!valid(current)) throw aborted();
                            current.failedUntil = Date.now() + (options.failureMs ?? 60000);
                            return undefined;
                        }
                    })();
                    current.posterPending = pending;
                    const settled = () => {
                        if (current.posterPending === pending) current.posterPending = undefined;
                    };
                    void pending.then(settled, settled);
                    return pending;
                },
                release: () => {
                    if (released) return;
                    released = true;
                    if (!valid(current)) return;
                    current.refs--;
                    current.lastUsed = Date.now();
                    if (!current.refs) {
                        current.grace = setTimeout(() => {
                            if (!current.refs) {
                                current.accessAbort?.abort();
                                current.posterAbort?.abort();
                            }
                        }, options.graceMs ?? 1000);
                        current.expiry = setTimeout(() => {
                            if (!current.refs) remove(current);
                        }, options.idleMs ?? 300000);
                        trim();
                    }
                },
            };
        },
    };
}
export type VideoResourceManager = ReturnType<typeof createVideoResourceManager>;
