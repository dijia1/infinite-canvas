"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const HISTORY_DELAY_MS = 180;
const HISTORY_LIMIT = 50;

type Timer = ReturnType<typeof setTimeout> | number;
type ClearTimer = { bivarianceHack(timer: Timer): void }["bivarianceHack"];

type HistoryState<TSnapshot> = {
    past: TSnapshot[];
    future: TSnapshot[];
};

export type CanvasHistoryControllerOptions<TSnapshot> = {
    applySnapshot: (snapshot: TSnapshot, applicationId: number) => TSnapshot | void;
    schedule?: (callback: () => void, delay: number) => Timer;
    clear?: ClearTimer;
    isSameSnapshot?: (left: TSnapshot, right: TSnapshot) => boolean;
    onStateChange?: (state: { canUndo: boolean; canRedo: boolean }) => void;
};

export type CanvasHistoryController<TSnapshot> = {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly isPausedRef: { current: boolean };
    readonly isApplyingRef: { current: boolean };
    observe: (snapshot: TSnapshot) => void;
    undo: () => void;
    redo: () => void;
    pause: () => void;
    resume: () => void;
    reset: () => void;
    replaceBaseline: (snapshot: TSnapshot) => void;
    rebase: (normalize: (snapshot: TSnapshot) => TSnapshot, current: TSnapshot) => void;
    completeApplication: (applicationId: number) => void;
    getRetainedHistory: () => { history: HistoryState<TSnapshot>; lastHistory: TSnapshot | null };
    dispose: () => void;
};

export function createCanvasHistoryController<TSnapshot>({
    applySnapshot,
    schedule = (callback, delay) => setTimeout(callback, delay),
    clear = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    isSameSnapshot = Object.is,
    onStateChange,
}: CanvasHistoryControllerOptions<TSnapshot>): CanvasHistoryController<TSnapshot> {
    const history: HistoryState<TSnapshot> = { past: [], future: [] };
    const isPausedRef = { current: false };
    const isApplyingRef = { current: false };
    let lastHistory: TSnapshot | null = null;
    let pendingSnapshot: TSnapshot | null = null;
    let pausedSnapshot: TSnapshot | null = null;
    let nextApplicationId = 0;
    let pendingApplicationId: number | null = null;
    let timer: Timer | null = null;

    const notify = () => {
        onStateChange?.({ canUndo: history.past.length > 0, canRedo: history.future.length > 0 });
    };

    const clearTimer = () => {
        if (timer !== null) {
            clear(timer);
            timer = null;
        }
        pendingSnapshot = null;
    };

    const commit = () => {
        timer = null;
        const next = pendingSnapshot;
        pendingSnapshot = null;
        if (next === null || lastHistory === null || isPausedRef.current || isApplyingRef.current || isSameSnapshot(lastHistory, next)) return;

        history.past = [...history.past.slice(-(HISTORY_LIMIT - 1)), lastHistory];
        history.future = [];
        lastHistory = next;
        notify();
    };

    const apply = (snapshot: TSnapshot) => {
        const applicationId = ++nextApplicationId;
        pendingApplicationId = applicationId;
        isApplyingRef.current = true;
        try {
            const applied = applySnapshot(snapshot, applicationId);
            // Normalization is part of restoration, not a new undoable edit.
            if (pendingApplicationId === applicationId && applied !== undefined) lastHistory = applied;
        } catch (error) {
            pendingApplicationId = null;
            isApplyingRef.current = false;
            throw error;
        }
        notify();
    };

    return {
        get canUndo() {
            return history.past.length > 0;
        },
        get canRedo() {
            return history.future.length > 0;
        },
        isPausedRef,
        isApplyingRef,
        observe(snapshot) {
            if (isApplyingRef.current) return;
            if (isPausedRef.current) { pausedSnapshot = snapshot; return; }
            if (lastHistory === null) {
                lastHistory = snapshot;
                return;
            }
            if (isSameSnapshot(lastHistory, snapshot)) return;

            clearTimer();
            pendingSnapshot = snapshot;
            timer = schedule(commit, HISTORY_DELAY_MS);
        },
        undo() {
            if (timer !== null) { clear(timer); commit(); }
            clearTimer();
            const previous = history.past.at(-1);
            if (previous === undefined || lastHistory === null) return;

            history.past.pop();
            history.future.push(lastHistory);
            lastHistory = previous;
            apply(previous);
        },
        redo() {
            if (timer !== null) { clear(timer); commit(); }
            clearTimer();
            const next = history.future.at(-1);
            if (next === undefined || lastHistory === null) return;

            history.future.pop();
            history.past.push(lastHistory);
            lastHistory = next;
            apply(next);
        },
        pause() {
            if (timer !== null) { clear(timer); commit(); }
            isPausedRef.current = true;
            pausedSnapshot = null;
            clearTimer();
        },
        resume() {
            isPausedRef.current = false;
            if (pausedSnapshot !== null) {
                clearTimer();
                pendingSnapshot = pausedSnapshot;
                pausedSnapshot = null;
                timer = schedule(commit, HISTORY_DELAY_MS);
            }
        },
        reset() {
            pendingApplicationId = null;
            isApplyingRef.current = false;
            isPausedRef.current = false;
            pausedSnapshot = null;
            clearTimer();
            history.past = [];
            history.future = [];
            notify();
        },
        rebase(normalize, current) {
            clearTimer();
            pausedSnapshot = null;
            history.past = history.past.map(normalize);
            history.future = history.future.map(normalize);
            lastHistory = current;
            isPausedRef.current = false;
            notify();
        },
        replaceBaseline(snapshot) {
            pausedSnapshot = null;
            isPausedRef.current = false;
            clearTimer();
            history.past = [];
            history.future = [];
            lastHistory = snapshot;
            pendingApplicationId = null;
            isApplyingRef.current = false;
            notify();
        },
        completeApplication(applicationId) {
            if (pendingApplicationId !== applicationId) return;

            pendingApplicationId = null;
            isApplyingRef.current = false;
            notify();
        },
        getRetainedHistory() {
            return { history, lastHistory };
        },
        dispose() {
            clearTimer();
            pausedSnapshot = null;
            pendingApplicationId = null;
            isApplyingRef.current = false;
            isPausedRef.current = false;
        },
    };
}

export type UseCanvasHistoryOptions<TSnapshot> = {
    snapshot: TSnapshot;
    applySnapshot: (snapshot: TSnapshot) => TSnapshot | void;
    isReady: boolean;
    isSameSnapshot?: (left: TSnapshot, right: TSnapshot) => boolean;
};

export type UseCanvasHistoryResult<TSnapshot> = Pick<CanvasHistoryController<TSnapshot>, "undo" | "redo" | "pause" | "resume" | "reset" | "replaceBaseline" | "rebase" | "getRetainedHistory" | "isPausedRef" | "isApplyingRef"> & {
    canUndo: boolean;
    canRedo: boolean;
};

export function useCanvasHistory<TSnapshot>({ snapshot, applySnapshot, isReady, isSameSnapshot }: UseCanvasHistoryOptions<TSnapshot>): UseCanvasHistoryResult<TSnapshot> {
    const applySnapshotRef = useRef(applySnapshot);
    applySnapshotRef.current = applySnapshot;
    const [state, setState] = useState({ canUndo: false, canRedo: false });
    const [committedApplicationId, setCommittedApplicationId] = useState<number | null>(null);
    const controllerRef = useRef<CanvasHistoryController<TSnapshot> | null>(null);

    if (!controllerRef.current) {
        controllerRef.current = createCanvasHistoryController({
            applySnapshot: (next, applicationId) => {
                const applied = applySnapshotRef.current(next);
                // This state update shares the synchronous React batch with the
                // restored editor fields; an unrelated render cannot acknowledge it.
                setCommittedApplicationId(applicationId);
                return applied;
            },
            isSameSnapshot,
            onStateChange: setState,
        });
    }

    const controller = controllerRef.current;

    useLayoutEffect(() => {
        if (!isReady) return;
        if (committedApplicationId !== null) controller.completeApplication(committedApplicationId);
        // Observe after acknowledgement so a result merged into this commit is
        // retained instead of being discarded as part of history restoration.
        controller.observe(snapshot);
    }, [committedApplicationId, controller, isReady, snapshot]);

    useEffect(() => () => controller.dispose(), [controller]);

    return {
        canUndo: state.canUndo,
        canRedo: state.canRedo,
        undo: controller.undo,
        redo: controller.redo,
        pause: controller.pause,
        resume: controller.resume,
        reset: controller.reset,
        replaceBaseline: controller.replaceBaseline,
        rebase: controller.rebase,
        getRetainedHistory: controller.getRetainedHistory,
        isPausedRef: controller.isPausedRef,
        isApplyingRef: controller.isApplyingRef,
    };
}
