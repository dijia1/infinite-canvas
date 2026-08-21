"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { ADMIN_AUTH_TOKEN_KEY, fetchCurrentAdmin, type AdminUser } from "@/services/api/admin";

type AdminStore = {
    token: string;
    user: AdminUser | null;
    isReady: boolean;
    isLoading: boolean;
    clearSession: () => void;
    hydrateAdmin: () => Promise<void>;
};

export const useAdminStore = create<AdminStore>()(
    persist(
        (set, get) => ({
            token: "",
            user: null,
            isReady: false,
            isLoading: false,
            clearSession: () => {
                set({ token: "", user: null, isReady: true });
                window.location.assign("/");
            },
            hydrateAdmin: async () => {
                set({ isLoading: true });
                try {
                    const user = await fetchCurrentAdmin("");
                    set({ token: "portal", user, isReady: true, isLoading: false });
                } catch {
                    set({ token: "", user: null, isReady: true, isLoading: false });
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
