import type { WorkflowRecord } from "./types";
import { workflowEditorSnapshot, type WorkflowEditorDocument } from "./workflow-editor-state";

export type WorkflowAutosaveState = {
    revision: number;
    dirty: boolean;
    status: "idle" | "pending" | "saving" | "error" | "conflict";
    error: unknown;
};

class WorkflowAutosaveInterruptedError extends Error {}

type Options = {
    save: (document: WorkflowEditorDocument, revision: number) => Promise<WorkflowRecord>;
    onSaved: (saved: WorkflowRecord, submittedSnapshot: string) => void;
    onError?: (error: unknown) => void;
    isConflict?: (error: unknown) => boolean;
    delayMs?: number;
};

// One controller belongs to one owner/workflow scope; dispose it when that scope changes.
export function createWorkflowAutosave(options: Options) {
    let latest: WorkflowEditorDocument | undefined;
    let savedSnapshot = "";
    let latestSnapshot = "";
    let state: WorkflowAutosaveState = { revision: 0, dirty: false, status: "idle", error: undefined };
    let enabled = false;
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: Promise<number> | undefined;
    let activeGeneration = 0;
    const listeners = new Set<() => void>();
    const emit = (patch: Partial<WorkflowAutosaveState>) => {
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener());
    };
    const clearTimer = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
    };
    const schedule = () => {
        clearTimer();
        if (!state.dirty && state.status === "pending") emit({ status: "idle" });
        if (!enabled || disposed || active || !state.dirty || state.error) return;
        emit({ status: "pending" });
        timer = setTimeout(() => {
            timer = undefined;
            void flush().catch(() => undefined);
        }, options.delayMs ?? 800);
    };
    const flush = (): Promise<number> => {
        clearTimer();
        if (disposed || !enabled) return Promise.reject(new Error("当前流程不可编辑"));
        if (state.error) return Promise.reject(state.error);
        if (active) return activeGeneration === generation ? active : active.catch(() => undefined).then(flush);
        if (!latest || !state.revision) return Promise.reject(new Error("流程尚未加载"));
        const epoch = generation;
        const drain = async () => {
            while (state.dirty) {
                if (disposed || !enabled || generation !== epoch) throw new WorkflowAutosaveInterruptedError("流程编辑会话已变化");
                const submitted = latest!;
                if (!submitted.name.trim()) throw new Error("请输入流程名称");
                const submittedSnapshot = latestSnapshot;
                emit({ status: "saving" });
                const saved = await options.save({ ...submitted, name: submitted.name.trim() }, state.revision);
                if (disposed || generation !== epoch) throw new WorkflowAutosaveInterruptedError("流程编辑会话已变化");
                savedSnapshot = workflowEditorSnapshot({ name: saved.name, graph: saved.graph });
                if (latestSnapshot === submittedSnapshot) { latest = { name: saved.name, graph: saved.graph }; latestSnapshot = savedSnapshot; }
                emit({ revision: saved.revision, dirty: latestSnapshot !== savedSnapshot });
                options.onSaved(saved, submittedSnapshot);
            }
            emit({ status: "idle", error: undefined });
            return state.revision;
        };
        activeGeneration = epoch;
        active = drain()
            .catch((error: unknown) => {
                if (!disposed && epoch === generation) {
                    if (error instanceof WorkflowAutosaveInterruptedError) emit({ status: "idle" });
                    else {
                        emit({ status: options.isConflict?.(error) ? "conflict" : "error", error });
                        options.onError?.(error);
                    }
                }
                throw error;
            })
            .finally(() => {
                active = undefined;
                if (!disposed) schedule();
            });
        return active;
    };
    return {
        // React StrictMode reuses the memoized controller after effect cleanup.
        // The prior dispose incremented generation, so its in-flight response remains fenced.
        activate() {
            disposed = false;
            schedule();
        },
        getState: () => state,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        reset(document: WorkflowEditorDocument, revision: number) {
            clearTimer();
            generation++;
            latest = document;
            savedSnapshot = latestSnapshot = workflowEditorSnapshot(document);
            emit({ revision, dirty: false, status: "idle", error: undefined });
        },
        update(document: WorkflowEditorDocument, snapshot = workflowEditorSnapshot(document)) {
            if (disposed) return;
            latest = document;
            latestSnapshot = snapshot;
            emit({ dirty: Boolean(savedSnapshot && latestSnapshot !== savedSnapshot) });
            schedule();
        },
        setEnabled(value: boolean) {
            enabled = value;
            if (!value) {
                clearTimer();
                if (state.status === "pending") emit({ status: "idle" });
            } else schedule();
        },
        flush,
        retry() {
            if (state.status === "conflict") return Promise.reject(state.error);
            emit({ error: undefined, status: "idle" });
            return flush();
        },
        dispose() {
            disposed = true;
            generation++;
            clearTimer();
            listeners.clear();
        },
    };
}
