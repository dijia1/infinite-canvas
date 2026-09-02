"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { setImageStorageScope } from "@/services/image-storage";
import { bootstrapCanvasProjects, retryCanvasBootstrapOnOnline } from "@/services/canvas-project-bootstrap";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const hydrateCanvas = useCanvasStore((state) => state.hydrate);
    const hydrateAssets = useAssetStore((state) => state.hydrate);
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    const pathname = usePathname();

    useEffect(() => {
        void loadPublicSettings();
    }, [loadPublicSettings, pathname]);

    useEffect(() => {
        let disposed = false;
        let bootstrapRetry: ReturnType<typeof retryCanvasBootstrapOnOnline> | null = null;
        void (async () => {
            let uid = "guest";
            try {
                const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/session`);
                const payload = (await response.json()) as { code?: number; data?: { user?: { uid?: string } } };
                uid = payload.code === 0 && payload.data?.user?.uid ? payload.data.user.uid : "guest";
            } catch {
                uid = "guest";
            }

            setImageStorageScope(uid);
            await Promise.all([hydrateCanvas(uid), hydrateAssets(uid)]);
            if (disposed || uid === "guest") return;

            bootstrapRetry = retryCanvasBootstrapOnOnline(async () => {
                const state = useCanvasStore.getState();
                await bootstrapCanvasProjects({
                    uid,
                    getProjects: () => useCanvasStore.getState().projects,
                    persistNormalizedProject: (id, nodes) => state.updateProject(id, { nodes }),
                    replaceProjectsFromServer: state.replaceProjectsFromServer,
                    startSync: state.startSync,
                });
            });
            if (disposed) bootstrapRetry.dispose();
            else void bootstrapRetry.attempt();
        })();

        return () => {
            disposed = true;
            bootstrapRetry?.dispose();
        };
    }, [hydrateAssets, hydrateCanvas]);

    return <>{children}</>;
}
