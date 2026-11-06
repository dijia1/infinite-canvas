"use client";

import { create } from "zustand";

import { ApiRequestError } from "@/services/api/request";

import { fetchCurrentAdmin, type AdminUser } from "@/services/api/admin";

type AdminStore = {
    user: AdminUser | null;
    isReady: boolean;
    isLoading: boolean;
    accessError: "identity" | "forbidden" | "unavailable" | null;
    clearSession: () => void;
    hydrateAdmin: () => Promise<void>;
};

export const useAdminStore = create<AdminStore>()(
    (set) => ({
        user: null,
        isReady: false,
        isLoading: false,
        accessError: null,
        clearSession: () => {
            set({ user: null, isReady: true, accessError: null });
            window.location.assign("/");
        },
        hydrateAdmin: async () => {
            set({ isLoading: true });
            try {
                const user = await fetchCurrentAdmin();
                set({ user, isReady: true, isLoading: false, accessError: null });
            } catch (error) {
                const status = error instanceof ApiRequestError ? error.status : undefined;
                set({ user: null, isReady: true, isLoading: false, accessError: status === 401 ? "identity" : status === 403 ? "forbidden" : "unavailable" });
            }
        },
    }),
);
