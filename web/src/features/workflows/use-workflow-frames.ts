"use client";

import { useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import type { CanvasFrameData, CanvasFrameResizeDirection } from "@/lib/canvas-frame";
import { moveWorkflowFrame, resizeWorkflowFrameFromHandle } from "./workflow-frames";
import type { WorkflowGraph } from "./types";

type GestureOptions = {
    updateGraph: Dispatch<SetStateAction<WorkflowGraph>>;
    isReadOnly: () => boolean;
    getScale: () => number;
    getViewport?: () => { x: number; y: number; k: number };
    pause: () => void;
    resume: () => void;
    onActiveChange: (active: boolean) => void;
    requestFrame: (callback: FrameRequestCallback) => number;
    cancelFrame: (id: number) => void;
};
type PointEvent = { clientX: number; clientY: number; pointerId: number };

// Apply positional deltas to the latest document so asynchronous media/layout updates survive a drag.
export function createWorkflowFrameGestureController(options: GestureOptions) {
    let session: { frame: CanvasFrameData; origin: PointEvent; corner?: CanvasFrameResizeDirection; worldOrigin: { x: number; y: number }; appliedX: number; appliedY: number } | undefined;
    let pending: PointEvent | undefined;
    let raf: number | undefined;
    const flush = () => {
        raf = undefined;
        const current = session;
        const event = pending;
        pending = undefined;
        if (!current || !event || options.isReadOnly()) return;
        const viewport = options.getViewport?.() || { x: 0, y: 0, k: options.getScale() };
        const x = (event.clientX - viewport.x) / viewport.k - current.worldOrigin.x;
        const y = (event.clientY - viewport.y) / viewport.k - current.worldOrigin.y;
        if (current.corner) {
            options.updateGraph((graph) => resizeWorkflowFrameFromHandle(graph, current.frame.id, current.frame, current.corner!, { x, y }));
        } else {
            const delta = { x: x - current.appliedX, y: y - current.appliedY };
            options.updateGraph((graph) => moveWorkflowFrame(graph, current.frame.id, delta));
            current.appliedX = x;
            current.appliedY = y;
        }
    };
    const finish = (event?: PointEvent) => {
        if (!session || (event && event.pointerId !== session.origin.pointerId)) return;
        if (event) pending = event;
        if (raf !== undefined) options.cancelFrame(raf);
        flush();
        session = undefined;
        options.onActiveChange(false);
        options.resume();
    };
    return {
        begin(frame: CanvasFrameData, event: PointEvent, corner?: CanvasFrameResizeDirection) {
            if (options.isReadOnly()) return false;
            finish();
            const viewport = options.getViewport?.() || { x: 0, y: 0, k: options.getScale() };
            session = { frame, origin: event, corner, worldOrigin: { x: (event.clientX - viewport.x) / viewport.k, y: (event.clientY - viewport.y) / viewport.k }, appliedX: 0, appliedY: 0 };
            options.pause();
            options.onActiveChange(true);
            return true;
        },
        move(event: PointEvent) {
            if (!session || session.origin.pointerId !== event.pointerId) return;
            pending = event;
            if (raf === undefined) raf = options.requestFrame(flush);
        },
        finish,
    };
}

export function useWorkflowFrameGestures(options: Omit<GestureOptions, "isReadOnly" | "getScale" | "onActiveChange" | "requestFrame" | "cancelFrame"> & { readOnly: boolean; scale: number }) {
    const latest = useRef(options);
    latest.current = options;
    const [active, setActive] = useState(false);
    const controller = useRef<ReturnType<typeof createWorkflowFrameGestureController> | null>(null);
    if (!controller.current) controller.current = createWorkflowFrameGestureController({
        updateGraph: (update) => latest.current.updateGraph(update),
        isReadOnly: () => latest.current.readOnly,
        getScale: () => latest.current.scale,
        getViewport: () => latest.current.getViewport?.() || { x: 0, y: 0, k: latest.current.scale },
        pause: () => latest.current.pause(), resume: () => latest.current.resume(),
        onActiveChange: setActive,
        requestFrame: (callback) => requestAnimationFrame(callback), cancelFrame: (id) => cancelAnimationFrame(id),
    });
    useEffect(() => {
        const handler = controller.current!;
        const move = (event: PointerEvent) => handler.move(event);
        const finish = (event: PointerEvent) => handler.finish(event);
        const cancel = () => handler.finish();
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("blur", cancel);
        return () => {
            window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
            window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel);
            cancel();
        };
    }, []);
    useEffect(() => { if (options.readOnly) controller.current?.finish(); }, [options.readOnly]);
    const start = (event: ReactPointerEvent<HTMLDivElement> | PointerEvent, frame: CanvasFrameData, corner?: CanvasFrameResizeDirection) => {
        if (event.button !== 0 || latest.current.readOnly) return;
        event.preventDefault(); event.stopPropagation();
        controller.current!.begin(frame, event, corner);
    };
    return { active, start, finish: () => controller.current?.finish() };
}
