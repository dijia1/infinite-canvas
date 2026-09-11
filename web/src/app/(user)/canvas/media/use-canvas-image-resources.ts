"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { loadMediaImage, loadMediaThumbnail, releaseImageObjectURL } from "@/services/image-storage";

import type { CanvasNodeData } from "../types";
import { getCanvasImageVariant } from "./canvas-media-policy";
import { createCanvasImageResourceController, type CanvasImageResourceController, type CanvasImageResourceRequest } from "./canvas-image-resource-controller";
import { createCanvasMediaLoadQueue } from "./canvas-media-load-queue";

export type CanvasMediaAccessResolver = (node: CanvasNodeData) => Promise<{ url: string; previewUrl?: string }>;

export type CanvasMediaTarget = {
    node: CanvasNodeData;
    visible: boolean;
    pinned: boolean;
    prefetch: boolean;
    preview?: boolean;
};

function isRemoteImageNode(node: CanvasNodeData) {
    return node.type === "image" && Boolean(node.metadata?.mediaId);
}

export function buildCanvasMediaTargets({
    onScreenNodes,
    prefetchNodes,
    pinnedNodes,
    previewNodes = [],
}: {
    onScreenNodes: CanvasNodeData[];
    prefetchNodes: CanvasNodeData[];
    pinnedNodes: CanvasNodeData[];
    previewNodes?: CanvasNodeData[];
}): CanvasMediaTarget[] {
    const targets = new Map<string, CanvasMediaTarget>();

    prefetchNodes.forEach((node) => {
        if (isRemoteImageNode(node)) targets.set(node.id, { node, visible: false, pinned: false, prefetch: true });
    });
    onScreenNodes.forEach((node) => {
        if (isRemoteImageNode(node)) targets.set(node.id, { node, visible: true, pinned: false, prefetch: false });
    });
    pinnedNodes.forEach((node) => {
        if (!isRemoteImageNode(node)) return;
        const current = targets.get(node.id);
        targets.set(node.id, current ? { ...current, node, pinned: true } : { node, visible: false, pinned: true, prefetch: false });
    });

    previewNodes.forEach((node) => {
        if (!isRemoteImageNode(node)) return;
        const current = targets.get(node.id);
        targets.set(node.id, current ? { ...current, preview: true } : { node, visible: false, pinned: false, prefetch: false, preview: true });
    });
    return [...targets.values()];
}

function deferObjectURLRelease(release: () => void) {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => release());
        return;
    }
    setTimeout(release, 0);
}

export function buildCanvasImageResourceRequests({
    targets,
    scale,
    controller,
    resolveAccess,
}: {
    targets: CanvasMediaTarget[];
    scale: number;
    controller: Pick<CanvasImageResourceController, "get">;
    resolveAccess: CanvasMediaAccessResolver;
}): CanvasImageResourceRequest[] {
    return targets.flatMap(({ node, visible, pinned, prefetch, preview }) => {
        const mediaId = node.type === "image" ? node.metadata?.mediaId : undefined;
        if (!mediaId) return [];
        const current = controller.get(node.id);
        const variant = getCanvasImageVariant({ visible, width: node.width, height: node.height, scale, pinned, preview, prefetch, currentVariant: current?.mediaId === mediaId ? current.variant : undefined });
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
                priority: pinned || preview ? ("interactive" as const) : prefetch && !visible ? ("prefetch" as const) : variant === "original" ? ("visible-original" as const) : ("visible-thumbnail" as const),
                releaseOriginalAfterThumbnail: Boolean(node.metadata?.content?.startsWith("blob:")),
                loadThumbnail: (signal: AbortSignal) => loadMediaThumbnail(mediaId, () => remoteURL("thumbnail"), { signal, preferRemoteThumbnail: !preview, maxThumbnailEdge: 512 }),
                loadOriginal: (signal: AbortSignal) => loadMediaImage(mediaId, () => remoteURL("original"), { signal }),
            },
        ];
    });
}

export function useCanvasImageResources({ targets, scale, resolveAccess }: { targets: CanvasMediaTarget[]; scale: number; resolveAccess: CanvasMediaAccessResolver }) {
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
        () => buildCanvasImageResourceRequests({ targets, scale, controller, resolveAccess }),
        [controller, resolveAccess, scale, targets, version],
    );

    useEffect(() => {
        // StrictMode replays effect setup after cleanup on the same controller.
        controller.activate();
        return () => controller.dispose();
    }, [controller]);

    useEffect(() => {
        controller.reconcile(requests);
    }, [controller, requests]);

    const resources = useMemo(() => controller.snapshot(), [controller, version]);
    const acknowledgeRendered = useCallback((nodeId: string, storageKey: string) => controller.acknowledgeRendered(nodeId, storageKey), [controller]);

    const retry = useCallback((nodeId: string) => controller.retry(nodeId), [controller]);
    return { resources, errors: controller.errors(), acknowledgeRendered, retry };
}
