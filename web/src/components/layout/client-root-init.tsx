"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";

import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useConfigStore } from "@/stores/use-config-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const hydrateCanvas = useCanvasStore((state) => state.hydrate);
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);

    useEffect(() => {
        void loadPublicSettings();
        void hydrateCanvas();
    }, [hydrateCanvas, loadPublicSettings]);

    return <>{children}</>;
}
