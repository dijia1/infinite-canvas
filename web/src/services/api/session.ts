import { apiGet } from "@/services/api/request";

export type PortalSession = {
    user: { uid: string; username: string; roles: string[] };
    isAdmin: boolean;
};

export function fetchPortalSession() {
    return apiGet<PortalSession>("/api/session");
}
