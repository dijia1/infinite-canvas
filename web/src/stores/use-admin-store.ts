"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { ApiRequestError } from "@/services/api/request";

import { ADMIN_AUTH_TOKEN_KEY, fetchCurrentAdmin, type AdminUser } from "@/services/api/admin";

type AdminStore = {
    token: string;
    user: AdminUser | null;
    isReady: boolean;
    isLoading: boolean;
    accessError: "identity" | "forbidden" | "unavailable" | null;
    clearSession: () => void;
    hydrateAdmin: () => Promise<void>;
};

export const useAdminStore = create<AdminStore>()(
    persist(
        (set) => ({
            token: "",
            user: null,
            isReady: false,
            isLoading: false,
            accessError: null,
            clearSession: () => {
                set({ token: "", user: null, isReady: true, accessError: null });
                window.location.assign("/");
            },
            hydrateAdmin: async () => {
                set({ isLoading: true });
                try {
                    const user = await fetchCurrentAdmin("");
                    set({ token: "portal", user, isReady: true, isLoading: false, accessError: null });
                } catch (error) {
                    const status = error instanceof ApiRequestError ? error.status : undefined;
                    set({ token: "", user: null, isReady: true, isLoading: false, accessError: status === 401 ? "identity" : status === 403 ? "forbidden" : "unavailable" });
                }
            },
        }),
        {
            name: ADMIN_AUTH_TOKEN_KEY,
            partialize: (state) => ({ token: state.token }),
            onRehydrateStorage: () => (state) => {
                if (state) state.isReady = false;
            },
        },
    ),
);
