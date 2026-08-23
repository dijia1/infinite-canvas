"use client";

import { useEffect, useRef, useState } from "react";

const HISTORY_DELAY_MS = 180;
const HISTORY_LIMIT = 50;

type Timer = ReturnType<typeof setTimeout> | number;
type ClearTimer = { bivarianceHack(timer: Timer): void }["bivarianceHack"];

type HistoryState<TSnapshot> = {
    past: TSnapshot[];
    future: TSnapshot[];
};

export type CanvasHistoryControllerOptions<TSnapshot> = {
    applySnapshot: (snapshot: TSnapshot) => void;
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
    completeApplication: (snapshot: TSnapshot) => void;
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
    let pendingApplication: TSnapshot | null = null;
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
        pendingApplication = snapshot;
        isApplyingRef.current = true;
        applySnapshot(snapshot);
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
            if (isPausedRef.current || isApplyingRef.current) return;
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
            clearTimer();
            const previous = history.past.at(-1);
            if (previous === undefined || lastHistory === null) return;

            history.past.pop();
            history.future.push(lastHistory);
            lastHistory = previous;
            apply(previous);
        },
        redo() {
            clearTimer();
            const next = history.future.at(-1);
            if (next === undefined || lastHistory === null) return;

            history.future.pop();
            history.past.push(lastHistory);
            lastHistory = next;
            apply(next);
        },
        pause() {
            isPausedRef.current = true;
            clearTimer();
        },
        resume() {
            isPausedRef.current = false;
        },
        reset() {
            clearTimer();
            history.past = [];
            history.future = [];
            notify();
        },
        replaceBaseline(snapshot) {
            clearTimer();
            history.past = [];
            history.future = [];
            lastHistory = snapshot;
            pendingApplication = null;
            isApplyingRef.current = false;
            notify();
        },
        completeApplication(snapshot) {
            if (pendingApplication === null || !isSameSnapshot(pendingApplication, snapshot)) return;

            pendingApplication = null;
            isApplyingRef.current = false;
            notify();
        },
        getRetainedHistory() {
            return { history, lastHistory };
        },
        dispose() {
            clearTimer();
        },
    };
}

export type UseCanvasHistoryOptions<TSnapshot> = {
    snapshot: TSnapshot;
    applySnapshot: (snapshot: TSnapshot) => void;
    isReady: boolean;
    isSameSnapshot?: (left: TSnapshot, right: TSnapshot) => boolean;
};

export type UseCanvasHistoryResult<TSnapshot> = Pick<CanvasHistoryController<TSnapshot>, "undo" | "redo" | "pause" | "resume" | "reset" | "replaceBaseline" | "getRetainedHistory" | "isPausedRef" | "isApplyingRef"> & {
    canUndo: boolean;
    canRedo: boolean;
};

export function useCanvasHistory<TSnapshot>({ snapshot, applySnapshot, isReady, isSameSnapshot }: UseCanvasHistoryOptions<TSnapshot>): UseCanvasHistoryResult<TSnapshot> {
    const applySnapshotRef = useRef(applySnapshot);
    applySnapshotRef.current = applySnapshot;
    const [state, setState] = useState({ canUndo: false, canRedo: false });
    const controllerRef = useRef<CanvasHistoryController<TSnapshot> | null>(null);

    if (!controllerRef.current) {
        controllerRef.current = createCanvasHistoryController({
            applySnapshot: (next) => applySnapshotRef.current(next),
            isSameSnapshot,
            onStateChange: setState,
        });
    }

    const controller = controllerRef.current;

    useEffect(() => {
        if (!isReady) return;
        controller.observe(snapshot);
        controller.completeApplication(snapshot);
    }, [controller, isReady, snapshot]);

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
        getRetainedHistory: controller.getRetainedHistory,
        isPausedRef: controller.isPausedRef,
        isApplyingRef: controller.isApplyingRef,
    };
}
