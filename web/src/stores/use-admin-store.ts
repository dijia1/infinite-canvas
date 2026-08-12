"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { ADMIN_AUTH_TOKEN_KEY, fetchCurrentAdmin, loginAdmin, type AdminUser } from "@/services/api/admin";

type AdminStore = {
    token: string;
    user: AdminUser | null;
    isReady: boolean;
    isLoading: boolean;
    clearSession: () => void;
    hydrateAdmin: () => Promise<void>;
    login: (payload: { username: string; password: string }) => Promise<AdminUser>;
};

export const useAdminStore = create<AdminStore>()(
    persist(
        (set, get) => ({
            token: "",
            user: null,
            isReady: false,
            isLoading: false,
            clearSession: () => set({ token: "", user: null, isReady: true }),
            hydrateAdmin: async () => {
                const token = get().token;
                if (!token) {
                    set({ user: null, isReady: true });
                    return;
                }
                set({ isLoading: true });
                try {
                    const user = await fetchCurrentAdmin(token);
                    set({ user, isReady: true, isLoading: false });
                } catch {
                    set({ token: "", user: null, isReady: true, isLoading: false });
                }
            },
            login: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await loginAdmin(payload);
                    set({ token: session.token, user: session.user, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
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
