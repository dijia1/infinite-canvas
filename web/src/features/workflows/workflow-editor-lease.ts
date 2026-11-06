"use client";

import { useEffect, useRef, useState } from "react";

import { claimCanvasProjectEditorLease, readCanvasProjectEditorLease } from "@/features/canvas/sync/canvas-project-editor-lease";

export function workflowEditorLeaseKey(ownerUID: string, workflowId: string) {
    return `infinite-canvas:workflow-editor:${JSON.stringify([ownerUID, workflowId])}`;
}

type LeaseState = { scope: string; status: "checking" | "editable" | "readonly" | "error"; error?: unknown };

// Ownership protects editing only. Server revision checks remain the final write guard.
export function useWorkflowEditorLease(ownerUID: string | undefined, workflowId: string | undefined, onAcquire: (signal: AbortSignal) => Promise<void>) {
    const scope = ownerUID && workflowId ? workflowEditorLeaseKey(ownerUID, workflowId) : "";
    const acquireRef = useRef(onAcquire);
    acquireRef.current = onAcquire;
    const [state, setState] = useState<LeaseState>({ scope: "", status: "checking" });
    useEffect(() => {
        if (!scope) return;
        const tabId = crypto.randomUUID();
        let disposed = false;
        let owner = false;
        let requesting = false;
        let activation = 0;
        let refreshAbort: AbortController | undefined;
        let activationFailed = false;
        let release: (() => void) | undefined;
        const locks = navigator.locks;
        const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(scope);
        const report = (status: LeaseState["status"], error?: unknown) => {
            if (!disposed) setState({ scope, status, error });
        };
        const activate = async () => {
            const epoch = ++activation;
            refreshAbort?.abort();
            const abort = new AbortController();
            refreshAbort = abort;
            activationFailed = false;
            report("checking");
            try {
                await acquireRef.current(abort.signal);
                if (owner && epoch === activation) report("editable");
            } catch (error) {
                if (owner && epoch === activation) {
                    activationFailed = true;
                    report("error", error);
                }
            }
        };
        const claimFallback = () => {
            try {
                return claimCanvasProjectEditorLease(window.localStorage, scope, tabId, Date.now(), 60_000);
            } catch {
                return false;
            }
        };
        const tryAcquire = () => {
            if (disposed || requesting || owner) return;
            if (!locks) {
                if (!claimFallback()) {
                    report("readonly");
                    return;
                }
                owner = true;
                channel?.postMessage("owner");
                void activate();
                return;
            }
            requesting = true;
            void locks
                .request(scope, { mode: "exclusive", ifAvailable: true }, async (lock) => {
                    if (!lock || disposed) {
                        report("readonly");
                        return;
                    }
                    owner = true;
                    // Install release before refreshing so unmount during refresh cannot leak the lock.
                    const released = new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    channel?.postMessage("owner");
                    void activate();
                    await released;
                    owner = false;
                    release = undefined;
                })
                .catch((error: unknown) => report("error", error))
                .finally(() => {
                    requesting = false;
                });
        };
        const releaseOwner = () => {
            activation++;
            refreshAbort?.abort();
            if (!owner) return;
            owner = false;
            report("readonly");
            if (!locks) {
                try {
                    if (readCanvasProjectEditorLease(window.localStorage, scope)?.tabId === tabId) window.localStorage.removeItem(scope);
                } catch {
                    /* Expiry releases an unavailable localStorage fallback. */
                }
            }
            release?.();
            channel?.postMessage("released");
        };
        const onStorage = (event: StorageEvent) => {
            if (locks || event.key !== scope) return;
            if (owner && !claimFallback()) releaseOwner();
            else if (!owner) tryAcquire();
        };
        const onMessage = () => {
            if (!locks && owner && !claimFallback()) releaseOwner();
            if (!owner) tryAcquire();
        };
        const onFocus = () => {
            if (!owner) tryAcquire();
            else if (!locks && !claimFallback()) releaseOwner();
            else if (activationFailed) void activate();
        };
        report("checking");
        channel?.addEventListener("message", onMessage);
        window.addEventListener("storage", onStorage);
        window.addEventListener("focus", onFocus);
        window.addEventListener("pageshow", onFocus);
        window.addEventListener("pagehide", releaseOwner);
        const heartbeat = setInterval(() => {
            if (owner && !locks && !claimFallback()) releaseOwner();
            else if (!owner) tryAcquire();
        }, 10_000);
        tryAcquire();
        return () => {
            disposed = true;
            releaseOwner();
            clearInterval(heartbeat);
            channel?.close();
            window.removeEventListener("storage", onStorage);
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("pageshow", onFocus);
            window.removeEventListener("pagehide", releaseOwner);
        };
    }, [scope]);
    return {
        editable: Boolean(scope && state.scope === scope && state.status === "editable"),
        status: state.scope === scope ? state.status : ("checking" as const),
        error: state.scope === scope ? state.error : undefined,
    };
}
