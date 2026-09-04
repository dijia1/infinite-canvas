import { apiGet } from "@/services/api/request";

export type PortalMember = {
    userUid: string;
    displayName: string;
    enabled: boolean;
    roles: string[];
    syncedAt: string;
};

export type PortalMemberList = {
    items: PortalMember[];
    total: number;
};

export function fetchPortalMembers(query: { page?: number; pageSize?: number; query?: string } = {}) {
    return apiGet<PortalMemberList>("/api/admin/members", query);
}
