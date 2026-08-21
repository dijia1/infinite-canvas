"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { setImageStorageScope } from "@/services/image-storage";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const hydrateCanvas = useCanvasStore((state) => state.hydrate);
    const hydrateAssets = useAssetStore((state) => state.hydrate);
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    const pathname = usePathname();

    useEffect(() => {
        void loadPublicSettings();
    }, [loadPublicSettings, pathname]);

    useEffect(() => {
        void (async () => {
            try {
                const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/session`);
                const payload = (await response.json()) as { code?: number; data?: { user?: { uid?: string } } };
                const uid = payload.code === 0 && payload.data?.user?.uid ? payload.data.user.uid : "guest";
                setImageStorageScope(uid);
                await Promise.all([hydrateCanvas(uid), hydrateAssets(uid)]);
            } catch {
                setImageStorageScope("guest");
                await Promise.all([hydrateCanvas("guest"), hydrateAssets("guest")]);
            }
        })();
    }, [hydrateAssets, hydrateCanvas]);

    return <>{children}</>;
}
