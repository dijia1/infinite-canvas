import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/app/(user)/canvas/types";
import { apiDelete, apiGet, apiPost, apiPut } from "./request";

export type CanvasProjectDocument = {
    nodes: CanvasNodeData[];
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

export type CanvasProjectsApi = {
    list: () => Promise<CanvasProjectList>;
    get: (id: string) => Promise<CanvasProjectRecord>;
    create: (input: CreateCanvasProjectInput) => Promise<CanvasProjectRecord>;
    importProjects: (projects: CreateCanvasProjectInput[]) => Promise<CanvasProjectList>;
    update: (id: string, input: UpdateCanvasProjectInput) => Promise<CanvasProjectRecord>;
    delete: (id: string, revision: number) => Promise<void>;
};

export function fetchCanvasProjects() {
    return apiGet<CanvasProjectList>("/api/v1/canvas/projects");
}

export function fetchCanvasProject(id: string) {
    return apiGet<CanvasProjectRecord>(`/api/v1/canvas/projects/${encodeURIComponent(id)}`);
}

export function createCanvasProject(input: CreateCanvasProjectInput) {
    return apiPost<CanvasProjectRecord>("/api/v1/canvas/projects", input);
}

export function importCanvasProjects(projects: CreateCanvasProjectInput[]) {
    return apiPost<CanvasProjectList>("/api/v1/canvas/projects/import", { projects });
}

export function updateCanvasProject(id: string, input: UpdateCanvasProjectInput) {
    return apiPut<CanvasProjectRecord>(`/api/v1/canvas/projects/${encodeURIComponent(id)}`, input);
}

export async function deleteCanvasProject(id: string, revision: number) {
    await apiDelete<true>(`/api/v1/canvas/projects/${encodeURIComponent(id)}`, undefined, { revision });
}

export const canvasProjectsApi: CanvasProjectsApi = {
    list: fetchCanvasProjects,
    get: fetchCanvasProject,
    create: createCanvasProject,
    importProjects: importCanvasProjects,
    update: updateCanvasProject,
    delete: deleteCanvasProject,
};
