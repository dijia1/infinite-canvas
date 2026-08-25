"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Modal, Slider } from "antd";
import { Check, Eraser, Pencil, Redo2, Trash2, Undo2, X } from "lucide-react";
import { nanoid } from "nanoid";

import type { ImageMask, ImageMaskPoint, ImageMaskStroke } from "@/types/image";

import { appendMaskStroke, drawImageMask, normalizeImageMask } from "./mask-utils";

type MaskTool = "paint" | "erase";
type CanvasImageMaskDialogProps = {
    image: string;
    initialMask: ImageMask | undefined;
    open: boolean;
    onClose: () => void;
    onSave: (mask: ImageMask | undefined) => void;
};

const DEFAULT_BRUSH_SIZE = 24;
const maskColor = "rgba(239, 68, 68, 0.3)";

export function CanvasImageMaskDialog({ image, initialMask, open, onClose, onSave }: CanvasImageMaskDialogProps) {
    const [mask, setMask] = useState<ImageMask | undefined>();
    const [undoStack, setUndoStack] = useState<Array<ImageMask | undefined>>([]);
    const [redoStack, setRedoStack] = useState<Array<ImageMask | undefined>>([]);
    const [tool, setTool] = useState<MaskTool>("paint");
    const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE);
    const maskRef = useRef<ImageMask | undefined>(undefined);

    useEffect(() => {
        if (!open) return;
        const nextMask = normalizeImageMask(initialMask);
        maskRef.current = nextMask;
        setMask(nextMask);
        setUndoStack([]);
        setRedoStack([]);
        setTool("paint");
        setBrushSize(DEFAULT_BRUSH_SIZE);
    }, [image, initialMask, open]);

    const commit = useCallback((next: ImageMask | undefined) => {
        setUndoStack((previous) => [...previous, maskRef.current]);
        setRedoStack([]);
        maskRef.current = next;
        setMask(next);
    }, []);

    const undo = useCallback(() => {
        if (!undoStack.length) return;
        const next = undoStack.at(-1);
        setUndoStack(undoStack.slice(0, -1));
        setRedoStack((previous) => [...previous, maskRef.current]);
        maskRef.current = next;
        setMask(next);
    }, [undoStack]);

    const redo = useCallback(() => {
        if (!redoStack.length) return;
        const next = redoStack.at(-1);
        setRedoStack(redoStack.slice(0, -1));
        setUndoStack((previous) => [...previous, maskRef.current]);
        maskRef.current = next;
        setMask(next);
    }, [redoStack]);

    return (
        <Modal title="编辑遮罩" open={open} onCancel={onClose} footer={null} width={920} centered destroyOnHidden>
            <div className="space-y-4" data-canvas-no-zoom>
                <MaskDrawingSurface image={image} mask={mask} tool={tool} brushSize={brushSize} onAddStroke={(stroke) => commit(appendMaskStroke(maskRef.current, stroke))} />
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-2">
                    <div className="flex items-center gap-2">
                        <Button size="small" type={tool === "paint" ? "primary" : "default"} icon={<Pencil className="size-3.5" />} onClick={() => setTool("paint")}>
                            画笔
                        </Button>
                        <Button size="small" type={tool === "erase" ? "primary" : "default"} icon={<Eraser className="size-3.5" />} onClick={() => setTool("erase")}>
                            橡皮擦
                        </Button>
                        <Button size="small" icon={<Undo2 className="size-3.5" />} disabled={!undoStack.length} onClick={undo} aria-label="撤销" />
                        <Button size="small" icon={<Redo2 className="size-3.5" />} disabled={!redoStack.length} onClick={redo} aria-label="重做" />
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!mask} onClick={() => commit(undefined)}>
                            清空
                        </Button>
                    </div>
                    <label className="flex min-w-[220px] items-center gap-3 text-sm">
                        <span className="shrink-0">画笔大小</span>
                        <Slider min={8} max={80} value={brushSize} onChange={(value) => setBrushSize(Array.isArray(value) ? DEFAULT_BRUSH_SIZE : value)} className="flex-1" />
                        <span className="w-8 text-right tabular-nums">{brushSize}</span>
                    </label>
                </div>
                <div className="flex justify-end gap-2">
                    <Button icon={<X className="size-4" />} onClick={onClose}>
                        取消
                    </Button>
                    <Button type="primary" icon={<Check className="size-4" />} onClick={() => onSave(mask)}>
                        保存遮罩
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

function MaskDrawingSurface({ image, mask, tool, brushSize, onAddStroke }: { image: string; mask: ImageMask | undefined; tool: MaskTool; brushSize: number; onAddStroke: (stroke: ImageMaskStroke) => void }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef<ImageMaskStroke | null>(null);

    const redraw = useCallback(
        (activeStroke?: ImageMaskStroke | null) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const width = Math.max(1, Math.round(rect.width));
            const height = Math.max(1, Math.round(rect.height));
            const ratio = Math.max(1, window.devicePixelRatio || 1);
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
            const context = canvas.getContext("2d");
            if (!context) return;
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
            drawImageMask(context, { version: 1, strokes: [...(mask?.strokes || []), ...(activeStroke ? [activeStroke] : [])] }, width, height, maskColor);
        },
        [mask],
    );

    useEffect(() => {
        redraw();
        const canvas = canvasRef.current;
        if (!canvas) return;
        const observer = new ResizeObserver(() => redraw(drawingRef.current));
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [redraw]);

    const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>): ImageMaskPoint | null => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
    };

    const begin = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const point = pointFromEvent(event);
        if (!point) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const rect = event.currentTarget.getBoundingClientRect();
        drawingRef.current = { id: nanoid(), tool, radius: Math.min(0.5, Math.max(0.0005, brushSize / Math.max(1, Math.min(rect.width, rect.height)) / 2)), points: [point] };
        redraw(drawingRef.current);
    };

    const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const current = drawingRef.current;
        const point = pointFromEvent(event);
        if (!current || !point) return;
        current.points.push(point);
        redraw(current);
    };

    const end = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const current = drawingRef.current;
        if (!current) return;
        drawingRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        onAddStroke(current);
    };

    return (
        <div className="flex max-h-[62vh] justify-center overflow-auto rounded-xl bg-black/5 p-2">
            <div className="relative inline-flex max-w-full">
                <img src={image} alt="编辑遮罩的原图" className="block max-h-[58vh] max-w-full select-none" draggable={false} />
                <canvas ref={canvasRef} className="absolute inset-0 h-full w-full cursor-crosshair touch-none" onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
            </div>
        </div>
    );
}
