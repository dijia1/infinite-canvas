import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/features/canvas/types";
import type { CanvasMaskResources } from "@/features/canvas/image-mask/mask-resources";
import { apiDelete, apiGet, apiPost, apiPut } from "./request";
import { sanitizeCanvasProjectDocument } from "../canvas-project-document";

export type CanvasProjectDocument = {
    nodes: CanvasNodeData[];
    maskResources?: CanvasMaskResources;
    connections: CanvasConnection[];
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasProjectDetail = {
    id: string;
    title: string;
    document: CanvasProjectDocument;
    revision: number;
    createdAt: string;
    updatedAt: string;
};

export type CanvasSummary = {
    id: string;
    title: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    nodeCount: number;
    connectionCount: number;
};

export type CanvasProjectSaveResult = CanvasProjectDetail | CanvasSummary;

export type CanvasProjectList = {
    items: CanvasSummary[];
    total: number;
};

export type CanvasProjectImportResult = {
    items: CanvasProjectDetail[];
    total: number;
};

export type CreateCanvasProjectInput = {
    id: string;
    title: string;
    document: CanvasProjectDocument;
    createdAt?: string;
    updatedAt?: string;
};

export type UpdateCanvasProjectInput = {
    revision: number;
    title: string;
    document: CanvasProjectDocument;
};

export type CanvasProjectWriteTrace = {
    tabId: string;
    requestId: string;
    requestSeq: number;
    reason: "autosave" | "retry" | "delete";
};

export type CanvasProjectsApi = {
    list: () => Promise<CanvasProjectList>;
    get: (id: string) => Promise<CanvasProjectDetail>;
    create: (input: CreateCanvasProjectInput) => Promise<CanvasProjectDetail>;
    importProjects: (projects: CreateCanvasProjectInput[]) => Promise<CanvasProjectImportResult>;
    update: (id: string, input: UpdateCanvasProjectInput, trace?: CanvasProjectWriteTrace) => Promise<CanvasProjectSaveResult>;
    delete: (id: string, revision: number, trace?: CanvasProjectWriteTrace) => Promise<void>;
};

export function fetchCanvasProjects() {
    return apiGet<CanvasProjectList>("/api/v1/canvas/projects");
}

export function fetchCanvasProject(id: string) {
    return apiGet<CanvasProjectDetail>(`/api/v1/canvas/projects/${encodeURIComponent(id)}`);
}

export function importCanvasPublicImages(id: string, revision: number) {
    return apiPost<{ project: CanvasProjectDetail; replacements: import("@/features/canvas/utils/canvas-public-image-migration").PublicImageReplacement[]; missingNodeIds: string[]; pendingNodeIds: string[] }>(
        `/api/v1/canvas/projects/${encodeURIComponent(id)}/public-images/import`,
        { revision },
    );
}

export function createCanvasProject(input: CreateCanvasProjectInput) {
    return apiPost<CanvasProjectDetail>("/api/v1/canvas/projects", { ...input, document: sanitizeCanvasProjectDocument(input.document) });
}

export async function importCanvasProjects(projects: CreateCanvasProjectInput[]) {
    const result: CanvasProjectImportResult = { items: [], total: 0 };
    const encoder = new TextEncoder();
    const maxBatchBytes = 8 << 20;
    const envelopeBytes = encoder.encode('{"projects":[]}').byteLength;
    let batch: CreateCanvasProjectInput[] = [];
    let batchBytes = envelopeBytes;
    const submit = async () => {
        const imported = await apiPost<CanvasProjectImportResult>("/api/v1/canvas/projects/import", { projects: batch });
        result.items.push(...imported.items);
        result.total += imported.total;
        batch = [];
        batchBytes = envelopeBytes;
    };
    // Sequential batches preserve import order. Retrying remains safe because
    // existing project IDs are never overwritten by the import endpoint.
    for (const project of projects) {
        const sanitized = { ...project, document: sanitizeCanvasProjectDocument(project.document) };
        const bytes = encoder.encode(JSON.stringify(sanitized)).byteLength;
        if (batch.length && (batch.length >= 200 || batchBytes + bytes + 1 > maxBatchBytes)) await submit();
        batchBytes += bytes + (batch.length ? 1 : 0);
        batch.push(sanitized);
    }
    if (batch.length || !projects.length) await submit();
    return result;
}

function canvasProjectWriteHeaders(trace?: CanvasProjectWriteTrace) {
    if (!trace) return undefined;
    return {
        "X-Canvas-Tab-Id": trace.tabId,
        "X-Canvas-Request-Id": trace.requestId,
        "X-Canvas-Request-Seq": String(trace.requestSeq),
        "X-Canvas-Save-Reason": trace.reason,
    };
}

export function updateCanvasProject(id: string, input: UpdateCanvasProjectInput, trace?: CanvasProjectWriteTrace) {
    return apiPut<CanvasProjectSaveResult>(`/api/v1/canvas/projects/${encodeURIComponent(id)}`, { ...input, document: sanitizeCanvasProjectDocument(input.document) }, { ...canvasProjectWriteHeaders(trace), "X-Canvas-Save-Response": "summary" });
}

export async function deleteCanvasProject(id: string, revision: number, trace?: CanvasProjectWriteTrace) {
    await apiDelete<true>(`/api/v1/canvas/projects/${encodeURIComponent(id)}`, { revision }, canvasProjectWriteHeaders(trace));
}

export const canvasProjectsApi: CanvasProjectsApi = {
    list: fetchCanvasProjects,
    get: fetchCanvasProject,
    create: createCanvasProject,
    importProjects: importCanvasProjects,
    update: updateCanvasProject,
    delete: deleteCanvasProject,
};
