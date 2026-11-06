import { uploadVideoMedia, type VideoMediaAccess, type VideoUploadOptions, type VideoUploadMetadata } from "@/services/api/video-media";
import type { CanvasNodeData } from "../types";

export type LocalVideoUploadView = { url: string; stage: "uploading" | "verifying" | "failed" | "ready"; progress: number; error?: string };
export function videoUploadSourceIdentity(node: CanvasNodeData) {
    return JSON.stringify([node.type, node.metadata?.mediaId, node.metadata?.content, node.metadata?.storageKey, node.metadata?.videoTaskId, node.metadata?.imageTaskId]);
}
type Options = {
    getNode: (id: string) => CanvasNodeData | undefined;
    canEdit: () => boolean;
    onChange: (views: Map<string, LocalVideoUploadView>) => void;
    onCompleted: (id: string, file: File, remote: VideoMediaAccess, source: CanvasNodeData, preparedMetadata?: VideoUploadMetadata) => void;
    upload?: typeof uploadVideoMedia;
    createURL?: (file: File) => string;
    revokeURL?: (url: string) => void;
};

// Preview, file bytes and progress belong to the page, never the saved graph.
export function createCanvasLocalVideoUploadController(options: Options) {
    type Entry = { source: CanvasNodeData; file: File; metadata?: VideoUploadMetadata; view: LocalVideoUploadView; abort?: AbortController; uploadedIntentId?: string; remoteId?: string };
    const entries = new Map<string, Entry>();
    const views = () => new Map([...entries].map(([id, entry]) => [id, entry.view]));
    const emit = () => options.onChange(views());
    const cancel = (id: string) => {
        const entry = entries.get(id);
        if (!entry) return;
        entries.delete(id);
        entry.abort?.abort();
        (options.revokeURL || URL.revokeObjectURL)(entry.view.url);
        emit();
    };
    const matches = (entry: Entry, node = options.getNode(entry.source.id)) => Boolean(node && (entry.remoteId ? node.metadata?.mediaId === entry.remoteId : videoUploadSourceIdentity(node) === videoUploadSourceIdentity(entry.source)));
    const run = async (entry: Entry) => {
        const id = entry.source.id;
        const abort = new AbortController();
        entry.abort = abort;
        const current = () => entries.get(id) === entry && entry.abort === abort && !abort.signal.aborted && options.canEdit() && matches(entry);
        const update = (patch: Partial<LocalVideoUploadView>) => {
            if (!current()) return;
            entry.view = { ...entry.view, ...patch };
            emit();
        };
        try {
            const uploadOptions: VideoUploadOptions = {
                metadata: entry.metadata,
                signal: abort.signal,
                uploadedIntentId: entry.uploadedIntentId,
                onProgress: (progress) => update({ progress }),
                onStage: (stage) => update({ stage, error: undefined }),
                onUploaded: (intent) => {
                    if (current()) entry.uploadedIntentId = intent;
                },
            };
            const remote = await (options.upload || uploadVideoMedia)(entry.file, uploadOptions);
            if (!current()) return;
            options.onCompleted(id, entry.file, remote, entry.source, entry.metadata);
            entry.remoteId = remote.mediaId;
            entry.view = { ...entry.view, stage: "ready", progress: 100, error: undefined };
            emit();
        } catch (error) {
            update({ stage: "failed", error: error instanceof Error ? error.message : "视频上传失败" });
        } finally {
            if (entry.abort === abort) entry.abort = undefined;
        }
    };
    return {
        views,
        start: (node: CanvasNodeData, file: File, metadata?: VideoUploadMetadata) => {
            if (!options.canEdit()) return Promise.resolve();
            cancel(node.id);
            const entry: Entry = { source: node, file, metadata, view: { url: (options.createURL || URL.createObjectURL)(file), stage: "uploading", progress: 0 } };
            entries.set(node.id, entry);
            emit();
            return run(entry);
        },
        retry: (id: string) => {
            const entry = entries.get(id);
            if (!entry || entry.abort || !options.canEdit() || !matches(entry)) return Promise.resolve();
            entry.view = { ...entry.view, stage: entry.uploadedIntentId ? "verifying" : "uploading", error: undefined, progress: entry.uploadedIntentId ? 100 : 0 };
            emit();
            return run(entry);
        },
        isPending: (id: string) => {
            const entry = entries.get(id);
            return Boolean(entry && entry.view.stage !== "ready");
        },
        reconcile: (nodes: CanvasNodeData[]) => {
            const byId = new Map(nodes.map((node) => [node.id, node]));
            for (const [id, entry] of entries) if (!options.canEdit() || !matches(entry, byId.get(id))) cancel(id);
        },
        cancel,
        dispose: () => {
            for (const id of [...entries.keys()]) cancel(id);
        },
    };
}
