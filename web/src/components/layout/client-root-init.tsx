"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const userId = useUserStore((state) => state.user?.id || null);
    const userReady = useUserStore((state) => state.isReady);
    const switchCanvasUserScope = useCanvasStore((state) => state.switchUserScope);
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    const isLoginPage = pathname === "/login" || pathname === "/admin/login";

    useEffect(() => {
        void loadPublicSettings();
    }, [loadPublicSettings]);

    useEffect(() => {
        if (!isLoginPage) void hydrateUser();
    }, [hydrateUser, isLoginPage]);

    useEffect(() => {
        if (userReady) void switchCanvasUserScope(userId);
    }, [switchCanvasUserScope, userId, userReady]);

    return <>{children}</>;
}
