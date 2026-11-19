"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ApiRequestError } from "@/services/api/request";
import type { CanvasEditorDocument } from "../hooks/use-canvas-document-sync";
import { useCanvasStore } from "../stores/use-canvas-store";
import { canvasProjectEditorLeaseKey, readCanvasProjectEditorLease, tryClaimCanvasProjectEditorLease } from "./canvas-project-editor-lease";
import { createCanvasProjectWriteTracer } from "./canvas-project-write-trace";

const leaseChannel = "infinite-canvas:project-editor-lease";
const leasePollMs = 10_000;
const fallbackLeaseMs = 60_000;
const loadRetryDelays = [500, 1500];

type OpenStatus =
    | { status: "loading" | "editable" }
    | { status: "occupied"; preview: boolean }
    | { status: "error"; message: string };

type EditorMessage = { type: "owner" | "released"; projectId: string; tabId: string };

const loading: OpenStatus = { status: "loading" };

function retryableLoad(error: unknown) {
    if (error instanceof ApiRequestError) return error.status === 408 || error.status === 429 || error.status >= 500;
    // The request client exposes transport errors as plain Errors. The store
    // also rejects detail responses that are older than a known revision.
    return error instanceof Error && /^(接口连接失败|请求超时|接口返回异常|画布版本已更新)/.test(error.message);
}

function loadErrorMessage(error: unknown) {
    if (!(error instanceof Error)) return "画布加载失败";
    if (error.message === "画布不存在") return "当前账号找不到该画布";
    if (error.message.startsWith("请求超时")) return "加载画布超时，请重试";
    return error.message;
}

export function useCanvasProjectOpen(
    projectId: string, scope: string | null, ready: boolean, readPendingDocument: () => CanvasEditorDocument | null,
) {
    const draftReader = useRef({ projectId, scope, readPendingDocument });
    useLayoutEffect(() => {
        draftReader.current = { projectId, scope, readPendingDocument };
    }, [projectId, scope, readPendingDocument]);

    const [result, setResult] = useState<{ projectId: string; scope: string | null; state: OpenStatus } | null>(null);
    const retry = useRef<() => void>(() => {});
    const tabId = useMemo(() => createCanvasProjectWriteTracer().tabId, []);

    useEffect(() => {
        if (!ready || !projectId) return;

        const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(leaseChannel);
        const locks = typeof navigator !== "undefined" && typeof navigator.locks?.request === "function" ? navigator.locks : null;
        const fallbackKey = canvasProjectEditorLeaseKey(projectId);
        const store = useCanvasStore.getState();
        let phase: OpenStatus = loading;
        let disposed = false;
        let hidden = false;
        let owner: (() => void) | null = null;
        let webRequest: Promise<unknown> | null = null;
        let releasing: Promise<void> | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;

        const sameScope = () => useCanvasStore.getState().syncScope === scope;
        const active = () => !disposed && !hidden && sameScope();
        const publish = (type: EditorMessage["type"]) => channel?.postMessage({ type, projectId, tabId } satisfies EditorMessage);
        const show = (state: OpenStatus) => {
            phase = state;
            if (!disposed && sameScope()) setResult({ projectId, scope, state });
        };
        const schedule = (callback: () => void, delay: number) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                timer = undefined;
                callback();
            }, delay);
        };
        const readDraft = () => {
            const reader = draftReader.current;
            return reader.projectId === projectId && reader.scope === scope ? reader.readPendingDocument() : null;
        };

        const release = (saveDraft: boolean, keepBlocked: boolean) => {
            clearTimeout(timer);
            clearInterval(heartbeat);
            const unlock = owner;
            owner = null;
            const currentScope = sameScope();
            const pending = saveDraft && unlock && currentScope ? readDraft() : null;
            if (pending) store.updateProject(projectId, pending);
            const saved = saveDraft && unlock && currentScope ? store.waitForLocalPersistence() : Promise.resolve();
            if (currentScope) {
                store.releaseProjectEditor(projectId);
                store.setProjectEditorOwned(projectId, false);
                if (keepBlocked) store.setProjectSyncBlocked(projectId, true);
            }
            if (!unlock) return releasing;

            const request = webRequest;
            releasing = (async () => {
                try {
                    await saved;
                } catch (error) {
                    console.warn("画布离开时本地保存失败", error instanceof Error ? error.message : String(error));
                }
                // Release before notifying followers. The channel stays open until
                // cleanup finishes, and a follower can acquire the lock on receipt.
                unlock();
                await request;
                releasing = null;
                publish("released");
                if (active() && phase.status === "loading") acquire();
            })();
            return releasing;
        };

        const fail = (error: unknown) => {
            show({ status: "error", message: loadErrorMessage(error) });
            void release(false, true);
        };

        const activate = (unlock: () => void) => {
            owner = unlock;
            show(loading);
            store.setProjectSyncBlocked(projectId, true);
            publish("owner");
            const isCurrent = () => active() && owner === unlock;

            const load = async (attempt: number) => {
                if (!isCurrent()) return;
                try {
                    await store.reloadProjectFromStorage(projectId, isCurrent);
                    if (!isCurrent()) return;
                    await store.ensureProjectDetail(projectId, { revalidate: true });
                    if (!isCurrent()) return;
                    store.setProjectEditorOwned(projectId, true);
                    store.setProjectSyncBlocked(projectId, false);
                    show({ status: "editable" });
                } catch (error) {
                    if (!isCurrent()) return;
                    const delay = loadRetryDelays[attempt];
                    if (delay !== undefined && retryableLoad(error)) schedule(() => void load(attempt + 1), delay);
                    else fail(error);
                }
            };
            void load(0);
        };

        const waitForEditor = () => {
            if (phase.status !== "occupied") {
                const preview = Boolean(store.openProject(projectId));
                show({ status: "occupied", preview });
                if (!preview) {
                    // A follower can view the saved detail without acquiring write access.
                    void store.ensureProjectDetail(projectId).then(() => {
                        if (active() && phase.status === "occupied") show({ status: "occupied", preview: true });
                    }, () => {
                        // Leave the explicit occupancy screen available for retry.
                    });
                }
            }
            schedule(acquire, leasePollMs);
        };

        const claimFallback = () => {
            try {
                return tryClaimCanvasProjectEditorLease(window.localStorage, fallbackKey, tabId, Date.now(), fallbackLeaseMs);
            } catch {
                return "unavailable";
            }
        };

        const checkFallback = () => {
            if (!owner || !active()) return;
            const claim = claimFallback();
            if (claim === "owned") return;
            const project = store.openProject(projectId);
            const sync = useCanvasStore.getState().projectSync[projectId];
            const pending = readDraft();
            if (project && (pending || sync?.dirty || sync?.pending || sync?.saving || sync?.conflict)) {
                void store.preserveProjectDraft(projectId, pending ? { ...project, ...pending } : project).catch(error => {
                    if (active()) store.reportProjectRecoveryError(projectId, error);
                });
            }
            if (claim === "unavailable") fail(new Error("浏览器无法保存画布编辑锁"));
            else {
                void release(false, true);
                waitForEditor();
            }
        };

        function acquire() {
            if (!active() || owner || webRequest || releasing || phase.status === "error") return;
            clearTimeout(timer);
            if (locks) {
                const request = locks.request(`infinite-canvas:project-editor:${projectId}`, { mode: "exclusive", ifAvailable: true }, async (lock) => {
                    if (!active()) return;
                    if (!lock) {
                        waitForEditor();
                        return;
                    }
                    const held = Promise.withResolvers<void>();
                    activate(held.resolve);
                    await held.promise;
                });
                webRequest = request;
                void request.then(() => {
                    webRequest = null;
                    if (phase.status === "loading") acquire();
                }, () => {
                    webRequest = null;
                    if (active()) fail(new Error("无法取得画布编辑锁"));
                });
                return;
            }

            const claim = claimFallback();
            if (claim === "occupied") waitForEditor();
            else if (claim === "unavailable") fail(new Error("浏览器无法保存画布编辑锁"));
            else {
                activate(() => {
                    try {
                        const storage = window.localStorage;
                        if (readCanvasProjectEditorLease(storage, fallbackKey)?.tabId === tabId) storage.removeItem(fallbackKey);
                    } catch (error) {
                        console.warn("画布编辑锁清理失败", error instanceof Error ? error.message : String(error));
                    }
                });
                heartbeat = setInterval(checkFallback, leasePollMs);
            }
        }

        const onMessage = (event: MessageEvent<EditorMessage>) => {
            const message = event.data;
            if (!message || message.projectId !== projectId || message.tabId === tabId || !active()) return;
            if (message.type === "released" && phase.status === "occupied") acquire();
            if (message.type === "owner" && !locks) checkFallback();
        };
        const onStorage = (event: StorageEvent) => {
            if (!locks && event.key === fallbackKey) {
                if (owner) checkFallback();
                else if (phase.status === "occupied") acquire();
            }
        };
        const onFocus = () => {
            if (phase.status === "occupied") acquire();
            else if (!locks) checkFallback();
        };
        const onPageHide = () => {
            hidden = true;
            void release(phase.status === "editable", true);
            show(loading);
        };
        const onPageShow = () => {
            if (!hidden) return;
            hidden = false;
            acquire();
        };

        retry.current = () => {
            if (!active() || (phase.status !== "error" && phase.status !== "occupied")) return;
            show(loading);
            acquire();
        };
        channel?.addEventListener("message", onMessage as EventListener);
        window.addEventListener("storage", onStorage);
        window.addEventListener("focus", onFocus);
        window.addEventListener("pagehide", onPageHide);
        window.addEventListener("pageshow", onPageShow);
        store.setProjectSyncBlocked(projectId, true);
        show(loading);
        acquire();

        return () => {
            disposed = true;
            retry.current = () => {};
            const released = release(phase.status === "editable", false);
            channel?.removeEventListener("message", onMessage as EventListener);
            if (released) void released.finally(() => channel?.close());
            else channel?.close();
            window.removeEventListener("storage", onStorage);
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("pagehide", onPageHide);
            window.removeEventListener("pageshow", onPageShow);
        };
    }, [projectId, scope, ready, tabId]);

    const state = ready && result?.projectId === projectId && result.scope === scope ? result.state : loading;
    return { state, retry: () => retry.current() };
}
