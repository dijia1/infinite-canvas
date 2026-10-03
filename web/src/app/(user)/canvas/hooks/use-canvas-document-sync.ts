"use client";

import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { useCanvasStore, type CanvasProject } from "../stores/use-canvas-store";

export type CanvasEditorDocument = Pick<CanvasProject, "nodes" | "connections" | "maskResources" | "backgroundMode" | "showImageInfo" | "viewport">;

const sameDocument = (a: CanvasEditorDocument, b: CanvasEditorDocument) =>
    a.nodes === b.nodes &&
    a.connections === b.connections &&
    a.maskResources === b.maskResources &&
    a.backgroundMode === b.backgroundMode &&
    a.showImageInfo === b.showImageInfo &&
    a.viewport.x === b.viewport.x &&
    a.viewport.y === b.viewport.y &&
    a.viewport.k === b.viewport.k;

export function createCanvasDocumentPublisher({
    publish,
    isCurrent,
    onPendingChange = () => undefined,
    schedule = (callback: () => void) => setTimeout(callback, 500),
    clear = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
}: {
    publish: (document: CanvasEditorDocument) => void;
    isCurrent: () => boolean;
    onPendingChange?: (pending: boolean) => void;
    schedule?: (callback: () => void) => ReturnType<typeof setTimeout>;
    clear?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
    let latest: CanvasEditorDocument | null = null;
    let published: CanvasEditorDocument | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;
    const setPending = (value: boolean) => {
        if (pending === value) return;
        pending = value;
        onPendingChange(value);
    };
    const cancelTimer = () => {
        if (timer !== null) clear(timer);
        timer = null;
    };
    const flush = () => {
        cancelTimer();
        if (!pending || !latest || !isCurrent()) return;
        // Publish before clearing pending: the Store now owns dirty/in-flight state.
        publish(latest);
        published = latest;
        setPending(false);
    };
    return {
        get pending() {
            return pending;
        },
        getPendingDocument: () => (pending ? latest : null),
        acceptBaseline(document: CanvasEditorDocument) {
            cancelTimer();
            latest = document;
            published = document;
            setPending(false);
        },
        capture(document: CanvasEditorDocument, baseline: CanvasEditorDocument) {
            // Capture current editor data for recovery even while publication is blocked.
            // The hook gates restoration identity; flush gates write permission.
            published ??= baseline;
            latest = document;
            setPending(!sameDocument(published, document));
            if (!pending) cancelTimer();
            // A fixed window keeps continuous gestures from starving local saves.
            else if (timer === null) timer = schedule(flush);
        },
        flush,
        flushViewport(viewport?: CanvasEditorDocument["viewport"]) {
            if (latest && viewport && !sameDocument(latest, { ...latest, viewport })) {
                latest = { ...latest, viewport };
                setPending(true);
            }
            flush();
        },
        cancel() {
            cancelTimer();
            setPending(false);
        },
    };
}

export function isCanvasDocumentPublicationCurrent(
    state: { syncScope: string | null; canonicalGeneration: number; readyForCanvasMutations: boolean; blockedProjectSync: Record<string, true>; projects: { id: string }[] },
    projectId: string,
    syncScope: string | null,
    canonicalGeneration: number,
) {
    return state.syncScope === syncScope && state.canonicalGeneration === canonicalGeneration && state.readyForCanvasMutations && !state.blockedProjectSync[projectId] && state.projects.some((project) => project.id === projectId);
}

export function useCanvasDocumentSync({
    projectId,
    syncScope,
    canonicalGeneration,
    isReady,
    document,
    baseline,
    getViewport,
}: {
    projectId: string;
    syncScope: string | null;
    canonicalGeneration: number;
    isReady: boolean;
    document: CanvasEditorDocument;
    baseline: CanvasEditorDocument | null;
    getViewport: () => CanvasEditorDocument["viewport"] | undefined;
}) {
    const [pendingDocument, setPendingDocument] = useState(false);
    const publisher = useMemo(
        () =>
            createCanvasDocumentPublisher({
                publish: (next) => {
                    const state = useCanvasStore.getState();
                    state.updateProject(projectId, next);
                    void state.waitForLocalPersistence().catch((error) => {
                        const current = useCanvasStore.getState();
                        if (current.syncScope === syncScope && current.canonicalGeneration === canonicalGeneration) current.reportProjectPersistenceError(projectId, error);
                    });
                },
                isCurrent: () => {
                    const state = useCanvasStore.getState();
                    return isCanvasDocumentPublicationCurrent(state, projectId, syncScope, canonicalGeneration);
                },
                onPendingChange: setPendingDocument,
            }),
        [projectId, syncScope, canonicalGeneration],
    );

    useLayoutEffect(
        () =>
            useCanvasStore.getState().registerProjectDraftReader(projectId, () => {
                const state = useCanvasStore.getState();
                return state.syncScope === syncScope && state.canonicalGeneration === canonicalGeneration ? publisher.getPendingDocument() : null;
            }),
        [projectId, syncScope, canonicalGeneration, publisher],
    );

    useLayoutEffect(() => {
        if (isReady && baseline) publisher.capture(document, baseline);
    }, [publisher, isReady, document, baseline]);

    useLayoutEffect(() => {
        const flush = () => publisher.flushViewport(getViewport());
        window.addEventListener("pagehide", flush);
        return () => {
            window.removeEventListener("pagehide", flush);
            // Route replacement may already have reused the canvas ref for another document.
            publisher.flush();
            publisher.cancel();
        };
    }, [publisher, getViewport]);

    const readPendingDocument = useCallback(() => {
        const state = useCanvasStore.getState();
        return state.syncScope === syncScope && state.canonicalGeneration === canonicalGeneration ? publisher.getPendingDocument() : null;
    }, [publisher, syncScope, canonicalGeneration]);

    return { pendingDocument, flushDocument: publisher.flushViewport, readPendingDocument, acceptDocumentBaseline: publisher.acceptBaseline };
}
