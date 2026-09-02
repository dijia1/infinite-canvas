import { CanvasNodeType, type CanvasNodeData } from "@/app/(user)/canvas/types";
import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import { uploadUserImage } from "@/services/api/image";
import { canvasProjectsApi, type CanvasProjectRecord, type CanvasProjectsApi, type CreateCanvasProjectInput } from "@/services/api/canvas-projects";
import { getImageBlob, uploadImage } from "@/services/image-storage";

type StableImage = {
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

export type LegacyCanvasImageDependencies = {
    getImageBlob: (storageKey: string) => Promise<Blob | null>;
    uploadUserImage: (file: File, intent: "library") => Promise<{ mediaId: string; url: string; mediaExpiresAt?: string }>;
    primeStableImage: (blob: Blob, mediaId: string) => Promise<StableImage>;
};

type CanvasBootstrapOptions = {
    uid: string;
    getProjects: () => CanvasProject[];
    api?: Pick<CanvasProjectsApi, "list" | "importProjects">;
    persistNormalizedProject?: (id: string, nodes: CanvasNodeData[]) => void;
    replaceProjectsFromServer: (projects: CanvasProjectRecord[]) => void;
    startSync: (uid: string) => void;
    imageDependencies?: LegacyCanvasImageDependencies;
};

type OnlineEventTarget = {
    addEventListener: (event: "online", listener: () => void) => void;
    removeEventListener: (event: "online", listener: () => void) => void;
};

const defaultImageDependencies: LegacyCanvasImageDependencies = {
    getImageBlob,
    uploadUserImage,
    primeStableImage: (blob, mediaId) => uploadImage(blob, mediaId),
};

function projectImportInput(project: CanvasProject): CreateCanvasProjectInput {
    return {
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        document: {
            nodes: project.nodes,
            connections: project.connections,
            backgroundMode: project.backgroundMode,
            showImageInfo: project.showImageInfo,
            viewport: project.viewport,
        },
    };
}

async function legacyImageBlob(node: CanvasNodeData, dependencies: LegacyCanvasImageDependencies) {
    const metadata = node.metadata;
    if (metadata?.storageKey) {
        const cached = await dependencies.getImageBlob(metadata.storageKey);
        if (cached) return cached;
    }
    if (!metadata?.content?.startsWith("data:image/")) return null;
    const response = await fetch(metadata.content);
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.type.startsWith("image/") ? blob : null;
}

function withoutTransientImageContent(node: CanvasNodeData): CanvasNodeData {
    if (!node.metadata?.content) return node;
    const { content: _content, ...metadata } = node.metadata;
    return { ...node, metadata };
}

async function normalizeLegacyImageNode(node: CanvasNodeData, dependencies: LegacyCanvasImageDependencies): Promise<CanvasNodeData> {
    if (node.type !== CanvasNodeType.Image) return node;
    if (node.metadata?.mediaId || node.metadata?.publicImageId) return withoutTransientImageContent(node);

    let blob: Blob | null = null;
    try {
        blob = await legacyImageBlob(node, dependencies);
        if (!blob) throw new Error("missing source");

        const extension = blob.type.split("/", 2)[1]?.replace(/[^a-zA-Z0-9.+-]/g, "") || "png";
        const remote = await dependencies.uploadUserImage(new File([blob], `canvas-image.${extension}`, { type: blob.type || "image/png" }), "library");
        const cached = await dependencies.primeStableImage(blob, remote.mediaId);
        const metadata = node.metadata || {};
        const {
            content: _content,
            storageKey: _storageKey,
            mediaId: _mediaId,
            mediaExpiresAt: _mediaExpiresAt,
            naturalWidth: _naturalWidth,
            naturalHeight: _naturalHeight,
            bytes: _bytes,
            mimeType: _mimeType,
            status: _status,
            errorDetails: _errorDetails,
            ...stableMetadata
        } = metadata;
        return {
            ...node,
            metadata: {
                ...stableMetadata,
                mediaId: remote.mediaId,
                storageKey: cached.storageKey,
                ...(remote.mediaExpiresAt ? { mediaExpiresAt: remote.mediaExpiresAt } : {}),
                naturalWidth: cached.width,
                naturalHeight: cached.height,
                bytes: cached.bytes,
                mimeType: cached.mimeType,
                status: "success",
            },
        };
    } catch {
        const metadata = node.metadata || {};
        const { content: _content, ...stableMetadata } = metadata;
        return {
            ...node,
            metadata: {
                ...stableMetadata,
                status: "error",
                errorDetails: "本地图片无法恢复，请重新上传图片",
            },
        };
    }
}

export async function normalizeLegacyCanvasProject(project: CanvasProject, dependencies: LegacyCanvasImageDependencies = defaultImageDependencies): Promise<CanvasProject> {
    const nodes: CanvasNodeData[] = [];
    for (const node of project.nodes) nodes.push(await normalizeLegacyImageNode(node, dependencies));
    return { ...project, nodes };
}

export async function bootstrapCanvasProjects(options: CanvasBootstrapOptions) {
    if (!options.uid || options.uid === "guest") return false;

    const api = options.api || canvasProjectsApi;
    const server = await api.list();
    const serverIds = new Set(server.items.map((project) => project.id));
    const missingLocalProjects = options.getProjects().filter((project) => !serverIds.has(project.id));
    const normalizedProjects: CanvasProject[] = [];
    for (const project of missingLocalProjects) {
        const normalized = await normalizeLegacyCanvasProject(project, options.imageDependencies || defaultImageDependencies);
        if (normalized.nodes.some((node, index) => node !== project.nodes[index])) options.persistNormalizedProject?.(project.id, normalized.nodes);
        normalizedProjects.push(normalized);
    }

    const imported = normalizedProjects.length ? await api.importProjects(normalizedProjects.map(projectImportInput)) : { items: [], total: 0 };
    const combined = new Map(server.items.map((project) => [project.id, project]));
    imported.items.forEach((project) => combined.set(project.id, project));
    options.replaceProjectsFromServer(Array.from(combined.values()));
    options.startSync(options.uid);
    return true;
}

export function retryCanvasBootstrapOnOnline(run: () => Promise<unknown>, target: OnlineEventTarget = window) {
    let disposed = false;
    let completed = false;
    let inFlight: Promise<void> | null = null;

    const onOnline = () => void attempt();
    const stop = () => target.removeEventListener("online", onOnline);
    const attempt = () => {
        if (disposed || completed) return inFlight || Promise.resolve();
        if (inFlight) return inFlight;
        inFlight = run()
            .then(() => {
                completed = true;
                stop();
            })
            .catch(() => undefined)
            .finally(() => {
                inFlight = null;
            });
        return inFlight;
    };

    target.addEventListener("online", onOnline);
    return {
        attempt,
        whenIdle: async () => {
            while (inFlight) await inFlight;
        },
        dispose: () => {
            disposed = true;
            stop();
        },
    };
}
