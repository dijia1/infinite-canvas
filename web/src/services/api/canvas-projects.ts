import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/app/(user)/canvas/types";
import type { CanvasMaskResources } from "@/app/(user)/canvas/image-mask/mask-resources";
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

export type CanvasProjectRecord = {
    id: string;
    title: string;
    document: CanvasProjectDocument;
    revision: number;
    createdAt: string;
    updatedAt: string;
};

export type CanvasProjectList = {
    items: CanvasProjectRecord[];
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
    get: (id: string) => Promise<CanvasProjectRecord>;
    create: (input: CreateCanvasProjectInput) => Promise<CanvasProjectRecord>;
    importProjects: (projects: CreateCanvasProjectInput[]) => Promise<CanvasProjectList>;
    update: (id: string, input: UpdateCanvasProjectInput, trace?: CanvasProjectWriteTrace) => Promise<CanvasProjectRecord>;
    delete: (id: string, revision: number, trace?: CanvasProjectWriteTrace) => Promise<void>;
};

export function fetchCanvasProjects() {
    return apiGet<CanvasProjectList>("/api/v1/canvas/projects");
}

export function fetchCanvasProject(id: string) {
    return apiGet<CanvasProjectRecord>(`/api/v1/canvas/projects/${encodeURIComponent(id)}`);
}

export function createCanvasProject(input: CreateCanvasProjectInput) {
    return apiPost<CanvasProjectRecord>("/api/v1/canvas/projects", { ...input, document: sanitizeCanvasProjectDocument(input.document) });
}

export function importCanvasProjects(projects: CreateCanvasProjectInput[]) {
    return apiPost<CanvasProjectList>("/api/v1/canvas/projects/import", { projects: projects.map((project) => ({ ...project, document: sanitizeCanvasProjectDocument(project.document) })) });
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
    return apiPut<CanvasProjectRecord>(`/api/v1/canvas/projects/${encodeURIComponent(id)}`, { ...input, document: sanitizeCanvasProjectDocument(input.document) }, undefined, canvasProjectWriteHeaders(trace));
}

export async function deleteCanvasProject(id: string, revision: number, trace?: CanvasProjectWriteTrace) {
    await apiDelete<true>(`/api/v1/canvas/projects/${encodeURIComponent(id)}`, undefined, { revision }, canvasProjectWriteHeaders(trace));
}

export const canvasProjectsApi: CanvasProjectsApi = {
    list: fetchCanvasProjects,
    get: fetchCanvasProject,
    create: createCanvasProject,
    importProjects: importCanvasProjects,
    update: updateCanvasProject,
    delete: deleteCanvasProject,
};
