"use client";

import { useEffect, useMemo } from "react";

import { useCanvasStore } from "../stores/use-canvas-store";
import { canvasProjectEditorLeaseKey, claimCanvasProjectEditorLease, readCanvasProjectEditorLease } from "./canvas-project-editor-lease";
import { cleanupExpiredCanvasProjectRecoverySnapshots, saveCanvasProjectRecoverySnapshot } from "./canvas-project-recovery-snapshot";
import { createCanvasProjectWriteTracer } from "./canvas-project-write-trace";

const canvasEditorLeaseChannel = "infinite-canvas:project-editor-lease";
const fallbackHeartbeatMs = 10_000;
const fallbackLeaseMs = 60_000;
const webLockRetryMs = 10_000;

type EditorMessage = {
    type: "owner" | "released";
    projectId: string;
    tabId: string;
};

type WebLockManager = {
    request: (name: string, options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: Lock | null) => Promise<void>) => Promise<void>;
};

function browserLocks(): WebLockManager | null {
    if (typeof navigator === "undefined") return null;
    const locks = (navigator as Navigator & { locks?: WebLockManager }).locks;
    return locks && typeof locks.request === "function" ? locks : null;
}

export function useCanvasProjectEditorLease(projectId: string) {
    const setProjectSyncBlocked = useCanvasStore((state) => state.setProjectSyncBlocked);
    const refreshProjectFromServer = useCanvasStore((state) => state.refreshProjectFromServer);
    const readyForCanvasMutations = useCanvasStore((state) => state.readyForCanvasMutations);
    const tabId = useMemo(() => createCanvasProjectWriteTracer().tabId, []);

    useEffect(() => {
        if (!projectId || typeof window === "undefined" || !readyForCanvasMutations) {
            setProjectSyncBlocked(projectId, !readyForCanvasMutations);
            return;
        }

        const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(canvasEditorLeaseChannel);
        const leaseKey = canvasProjectEditorLeaseKey(projectId);
        let disposed = false;
        let ownsEditor = false;
        let usingFallback = false;
        let releaseWebLock: (() => void) | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let takeover: ReturnType<typeof setInterval> | null = null;
        let locks: WebLockManager | null = null;
        let requestingWebLock = false;
        let webLockRetry: ReturnType<typeof setTimeout> | null = null;

        const publish = (type: EditorMessage["type"]) => channel?.postMessage({ type, projectId, tabId } satisfies EditorMessage);

        const preserveLocalDraft = () => {
            const state = useCanvasStore.getState();
            const project = state.projects.find((item) => item.id === projectId);
            const sync = state.projectSync[projectId];
            if (!project || !sync || (!sync.dirty && !sync.pending && !sync.saving && !sync.conflict)) return;
            void saveCanvasProjectRecoverySnapshot(projectId, tabId, project)
                .then(() => cleanupExpiredCanvasProjectRecoverySnapshots())
                .catch(() => undefined);
        };

        const becomeReadonly = (refresh = true) => {
            if (disposed) return;
            ownsEditor = false;
            setProjectSyncBlocked(projectId, true);
            if (refresh) preserveLocalDraft();
            if (refresh) void refreshProjectFromServer(projectId).catch(() => undefined);
        };

        const activateOwner = async () => {
            if (disposed || !ownsEditor) return;
            setProjectSyncBlocked(projectId, true);
            try {
                await refreshProjectFromServer(projectId);
                if (!disposed && ownsEditor) setProjectSyncBlocked(projectId, false);
            } catch {
                if (!disposed) setProjectSyncBlocked(projectId, true);
            }
        };

        const claimFallbackLease = () => {
            return claimCanvasProjectEditorLease(window.localStorage, leaseKey, tabId, Date.now(), fallbackLeaseMs);
        };

        const loseFallbackOwnership = () => {
            if (!ownsEditor) return;
            becomeReadonly(true);
        };

        const startFallback = () => {
            usingFallback = true;
            const tryTakeover = () => {
                if (disposed || ownsEditor || !claimFallbackLease()) return;
                ownsEditor = true;
                publish("owner");
                void activateOwner();
            };
            tryTakeover();
            heartbeat = setInterval(() => {
                if (disposed || !ownsEditor) return;
                if (!claimFallbackLease()) loseFallbackOwnership();
            }, fallbackHeartbeatMs);
            takeover = setInterval(tryTakeover, fallbackHeartbeatMs);
        };

        const requestWebLock = () => {
            if (!locks || disposed || ownsEditor || requestingWebLock) return;
            requestingWebLock = true;
            void locks
                .request(`infinite-canvas:project-editor:${projectId}`, { mode: "exclusive", ifAvailable: true }, async (lock) => {
                    if (!lock || disposed) {
                        becomeReadonly(false);
                        return;
                    }
                    ownsEditor = true;
                    publish("owner");
                    await activateOwner();
                    await new Promise<void>((resolve) => {
                        releaseWebLock = resolve;
                    });
                    ownsEditor = false;
                })
                .finally(() => {
                    requestingWebLock = false;
                    if (!disposed && !ownsEditor && !usingFallback) {
                        if (webLockRetry) clearTimeout(webLockRetry);
                        webLockRetry = setTimeout(requestWebLock, webLockRetryMs);
                    }
                });
        };

        const onMessage = (event: MessageEvent<EditorMessage>) => {
            const message = event.data;
            if (!message || message.projectId !== projectId || message.tabId === tabId) return;
            if (message.type === "owner") {
                if (!ownsEditor) setProjectSyncBlocked(projectId, true);
                if (usingFallback && ownsEditor && readCanvasProjectEditorLease(window.localStorage, leaseKey)?.tabId !== tabId) loseFallbackOwnership();
                return;
            }
            if (message.type === "released" && !ownsEditor) {
                if (usingFallback && claimFallbackLease()) {
                    ownsEditor = true;
                    publish("owner");
                    void activateOwner();
                } else if (!usingFallback) {
                    requestWebLock();
                }
            }
        };

        const onStorage = (event: StorageEvent) => {
            if (!usingFallback || event.key !== leaseKey || !ownsEditor) return;
            if (readCanvasProjectEditorLease(window.localStorage, leaseKey)?.tabId !== tabId) loseFallbackOwnership();
        };

        const onFocus = () => {
            if (disposed) return;
            if (!usingFallback) {
                if (!ownsEditor) requestWebLock();
                return;
            }
            if (ownsEditor) {
                if (!claimFallbackLease()) loseFallbackOwnership();
                return;
            }
            if (!claimFallbackLease()) return;
            ownsEditor = true;
            publish("owner");
            void activateOwner();
        };

        const releaseOwnership = () => {
            if (!ownsEditor) return;
            publish("released");
            if (usingFallback && readCanvasProjectEditorLease(window.localStorage, leaseKey)?.tabId === tabId) window.localStorage.removeItem(leaseKey);
            releaseWebLock?.();
            ownsEditor = false;
        };

        setProjectSyncBlocked(projectId, true);
        channel?.addEventListener("message", onMessage as EventListener);
        window.addEventListener("storage", onStorage);
        window.addEventListener("focus", onFocus);
        window.addEventListener("pagehide", releaseOwnership);

        locks = browserLocks();
        if (locks) {
            requestWebLock();
        } else {
            startFallback();
        }

        return () => {
            disposed = true;
            if (heartbeat) clearInterval(heartbeat);
            if (takeover) clearInterval(takeover);
            if (webLockRetry) clearTimeout(webLockRetry);
            releaseOwnership();
            channel?.removeEventListener("message", onMessage as EventListener);
            channel?.close();
            window.removeEventListener("storage", onStorage);
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("pagehide", releaseOwnership);
            setProjectSyncBlocked(projectId, false);
        };
    }, [projectId, readyForCanvasMutations, refreshProjectFromServer, setProjectSyncBlocked, tabId]);
}
