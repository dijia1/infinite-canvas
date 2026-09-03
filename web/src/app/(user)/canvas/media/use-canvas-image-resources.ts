"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { loadMediaImage, loadMediaThumbnail, releaseImageObjectURL } from "@/services/image-storage";

import type { CanvasNodeData } from "../types";
import { getCanvasImageVariant } from "./canvas-media-policy";
import { createCanvasImageResourceController } from "./canvas-image-resource-controller";
import { createCanvasMediaLoadQueue } from "./canvas-media-load-queue";

export type CanvasMediaAccessResolver = (node: CanvasNodeData) => Promise<{ url: string; previewUrl?: string }>;

function deferObjectURLRelease(release: () => void) {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => release());
        return;
    }
    setTimeout(release, 0);
}

export function useCanvasImageResources({ nodes, scale, pinnedNodeIds, resolveAccess }: { nodes: CanvasNodeData[]; scale: number; pinnedNodeIds: ReadonlySet<string>; resolveAccess: CanvasMediaAccessResolver }) {
    const [version, notify] = useReducer((value) => value + 1, 0);
    const controllerRef = useRef<ReturnType<typeof createCanvasImageResourceController> | null>(null);
    if (!controllerRef.current) {
        controllerRef.current = createCanvasImageResourceController({
            queue: createCanvasMediaLoadQueue({ concurrency: 4 }),
            releaseObjectURL: releaseImageObjectURL,
            deferRelease: deferObjectURLRelease,
            onChange: notify,
        });
    }
    const controller = controllerRef.current;

    const requests = useMemo(
        () =>
            nodes.flatMap((node) => {
                const mediaId = node.type === "image" ? node.metadata?.mediaId : undefined;
                if (!mediaId) return [];
                const current = controller.get(node.id);
                const variant = getCanvasImageVariant({
                    visible: true,
                    width: node.width,
                    height: node.height,
                    scale,
                    pinned: pinnedNodeIds.has(node.id),
                    currentVariant: current?.variant,
                });
                if (variant === "none") return [];
                const remoteURL = async (kind: "thumbnail" | "original") => {
                    const access = await resolveAccess(node);
                    return kind === "thumbnail" ? access.previewUrl || access.url : access.url;
                };
                return [
                    {
                        nodeId: node.id,
                        mediaId,
                        variant,
                        priority: pinnedNodeIds.has(node.id) ? ("interactive" as const) : variant === "original" ? ("visible-original" as const) : ("visible-thumbnail" as const),
                        releaseOriginalAfterThumbnail: Boolean(node.metadata?.content?.startsWith("blob:")),
                        loadThumbnail: (signal: AbortSignal) => loadMediaThumbnail(mediaId, () => remoteURL("thumbnail"), { signal, preferRemoteThumbnail: true }),
                        loadOriginal: (signal: AbortSignal) => loadMediaImage(mediaId, () => remoteURL("original"), { signal }),
                    },
                ];
            }),
        [controller, nodes, pinnedNodeIds, resolveAccess, scale, version],
    );

    useEffect(() => {
        controller.reconcile(requests);
    }, [controller, requests]);

    useEffect(
        () => () => {
            controller.dispose();
        },
        [controller],
    );

    const resources = useMemo(() => controller.snapshot(), [controller, version]);
    const acknowledgeRendered = useCallback((nodeId: string, storageKey: string) => controller.acknowledgeRendered(nodeId, storageKey), [controller]);

    return { resources, acknowledgeRendered };
}
