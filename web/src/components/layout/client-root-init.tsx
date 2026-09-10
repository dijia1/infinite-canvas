"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { portalSessionQuery } from "@/services/api/session";

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
    const hydrationScope = useRef<string | null>(null);
    const session = useQuery(portalSessionQuery);
    const uid = session.isPending ? undefined : session.isError ? "guest" : session.data?.user?.uid || "guest";

    useEffect(() => {
        void loadPublicSettings();
    }, [loadPublicSettings, pathname]);

    useEffect(() => {
        if (uid === undefined) return;
        const canvasScope = hydrationScope.current || useCanvasStore.getState().syncScope;
        if (canvasScope && canvasScope !== uid) {
            // Canvas hydration is one-shot. Recreate the page before another
            // session can bootstrap or import the previous user's local projects.
            window.location.reload();
            return;
        }
        hydrationScope.current = uid;
        let disposed = false;
        let bootstrapRetry: ReturnType<typeof retryCanvasBootstrapOnOnline> | null = null;
        void (async () => {
            setImageStorageScope(uid);
            await Promise.all([hydrateCanvas(uid), hydrateAssets(uid)]);
            if (disposed || uid === "guest") return;

            bootstrapRetry = retryCanvasBootstrapOnOnline(async () => {
                const state = useCanvasStore.getState();
                await bootstrapCanvasProjects({
                    uid,
                    getProjects: () => useCanvasStore.getState().projects,
                    persistNormalizedProject: state.applyLegacyImageNormalization,
                    adoptImportedProjects: state.adoptImportedProjects,
                    mergeProjectSummaries: state.mergeProjectSummaries,
                    isCurrent: () => !disposed && useCanvasStore.getState().syncScope === uid,
                    startSync: state.startSync,
                }).catch((error) => {
                    useCanvasStore.getState().markBootstrapUnavailable(uid, error);
                    throw error;
                });
            });
            if (disposed) bootstrapRetry.dispose();
            else {
                useCanvasStore.getState().setBootstrapRetry(() => bootstrapRetry?.attempt() || Promise.resolve());
                void bootstrapRetry.attempt();
            }
        })();

        return () => {
            disposed = true;
            bootstrapRetry?.dispose();
            useCanvasStore.getState().setBootstrapRetry(null);
        };
    }, [hydrateAssets, hydrateCanvas, uid]);

    return <>{children}</>;
}
