import { apiGet, apiPost } from "./request";

export type CanvasShareRecipient = {
    userUid: string;
    displayName: string;
    roles: string[];
};

export type CanvasShareRecipientList = {
    items: CanvasShareRecipient[];
    total: number;
};

export type CanvasShareInput = {
    revision: number;
    recipientUserUids: string[];
};

export type CanvasShareDelivery = {
    recipientUserUid: string;
    projectId?: string;
    status: "shared" | "failed";
    message?: string;
};

export type CanvasShareResult = {
    deliveries: CanvasShareDelivery[];
};

export function fetchCanvasShareRecipients(query: { page?: number; pageSize?: number; query?: string } = {}) {
    return apiGet<CanvasShareRecipientList>("/api/v1/canvas/share-recipients", query);
}

export function shareCanvasProject(id: string, input: CanvasShareInput) {
    return apiPost<CanvasShareResult>(`/api/v1/canvas/projects/${encodeURIComponent(id)}/share`, input);
}
