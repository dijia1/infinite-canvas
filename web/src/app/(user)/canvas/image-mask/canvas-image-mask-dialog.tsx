"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, ColorPicker, Modal, Slider } from "antd";
import { Check, Eraser, Pencil, Redo2, Trash2, Undo2, X } from "lucide-react";
import { nanoid } from "nanoid";

import { MASK_PREVIEW_OPACITY, useMaskPreferencesStore } from "@/stores/use-mask-preferences-store";
import type { ImageMask, ImageMaskPoint, ImageMaskStroke } from "@/types/image";

import { adjustMaskBrushSize, DEFAULT_BRUSH_SIZE, maskBrushKeyDelta, maskBrushRadius, MAX_BRUSH_SIZE, MIN_BRUSH_SIZE } from "./mask-brush";
import { appendMaskStroke, drawImageMask, normalizeImageMask } from "./mask-utils";

type MaskTool = "paint" | "erase";
type CanvasImageMaskDialogProps = {
    image: string;
    initialMask: ImageMask | undefined;
    open: boolean;
    onClose: () => void;
    onSave: (mask: ImageMask | undefined) => void;
};

export function CanvasImageMaskDialog({ image, initialMask, open, onClose, onSave }: CanvasImageMaskDialogProps) {
    const [mask, setMask] = useState<ImageMask | undefined>();
    const [undoStack, setUndoStack] = useState<Array<ImageMask | undefined>>([]);
    const [redoStack, setRedoStack] = useState<Array<ImageMask | undefined>>([]);
    const [tool, setTool] = useState<MaskTool>("paint");
    const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE);
    const maskRef = useRef<ImageMask | undefined>(undefined);
    const dialogRef = useRef<HTMLDivElement>(null);
    const maskColor = useMaskPreferencesStore((state) => state.previewColor);
    const setMaskColor = useMaskPreferencesStore((state) => state.setPreviewColor);

    useEffect(() => {
        if (!open) return;
        const handleKey = (event: KeyboardEvent) => {
            const target = event.target;
            if (!(target instanceof Element) || !dialogRef.current?.contains(target)) return;
            if (target.closest('input, textarea, [role="textbox"], [contenteditable]:not([contenteditable="false"])')) return;
            const delta = maskBrushKeyDelta(event);
            if (!delta) return;
            event.preventDefault();
            event.stopPropagation();
            setBrushSize((size) => adjustMaskBrushSize(size, delta));
        };
        document.addEventListener("keydown", handleKey, true);
        return () => document.removeEventListener("keydown", handleKey, true);
    }, [open]);

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
        const current = maskRef.current;
        setUndoStack((previous) => [...previous, current]);
        setRedoStack([]);
        maskRef.current = next;
        setMask(next);
    }, []);

    const undo = useCallback(() => {
        if (!undoStack.length) return;
        const next = undoStack.at(-1);
        setUndoStack(undoStack.slice(0, -1));
        const current = maskRef.current;
        setRedoStack((previous) => [...previous, current]);
        maskRef.current = next;
        setMask(next);
    }, [undoStack]);

    const redo = useCallback(() => {
        if (!redoStack.length) return;
        const next = redoStack.at(-1);
        setRedoStack(redoStack.slice(0, -1));
        const current = maskRef.current;
        setUndoStack((previous) => [...previous, current]);
        maskRef.current = next;
        setMask(next);
    }, [redoStack]);

    return (
        <Modal title="编辑遮罩" open={open} onCancel={onClose} footer={null} width={920} centered destroyOnHidden modalRender={(modal) => <div ref={dialogRef}>{modal}</div>}>
            <div className="space-y-4" data-canvas-no-zoom>
                <MaskDrawingSurface image={image} mask={mask} tool={tool} brushSize={brushSize} color={maskColor} onAddStroke={(stroke) => commit(appendMaskStroke(maskRef.current, stroke))} />
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
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
                        <ColorPicker value={maskColor} onChange={(color) => setMaskColor(color.toHexString())} disabledAlpha format="hex" size="small">
                            <Button size="small" aria-label="遮罩颜色" icon={<span className="inline-block size-3 rounded-sm border" style={{ backgroundColor: maskColor }} />}>
                                遮罩颜色
                            </Button>
                        </ColorPicker>
                    </div>
                    <label className="flex min-w-[220px] items-center gap-3 text-sm">
                        <span className="shrink-0" title="[ 缩小，] 放大">{tool === "paint" ? "画笔大小" : "橡皮擦大小"}</span>
                        <Slider min={MIN_BRUSH_SIZE} max={MAX_BRUSH_SIZE} value={brushSize} onChange={(value) => setBrushSize(Array.isArray(value) ? DEFAULT_BRUSH_SIZE : value)} className="flex-1" aria-label={tool === "paint" ? "画笔大小" : "橡皮擦大小"} />
                        <span className="w-12 text-right tabular-nums" data-mask-brush-size>{brushSize}px</span>
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

function MaskDrawingSurface({ image, mask, tool, brushSize, color, onAddStroke }: { image: string; mask: ImageMask | undefined; tool: MaskTool; brushSize: number; color: string; onAddStroke: (stroke: ImageMaskStroke) => void }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef<ImageMaskStroke | null>(null);
    const cursorRef = useRef<HTMLDivElement>(null);
    const pointerRef = useRef<{ x: number; y: number } | null>(null);
    const cursorFrameRef = useRef<number | null>(null);
    const brushSizeRef = useRef(brushSize);
    brushSizeRef.current = brushSize;

    const scheduleCursor = useCallback(() => {
        if (cursorFrameRef.current !== null) return;
        cursorFrameRef.current = requestAnimationFrame(() => {
            cursorFrameRef.current = null;
            const canvas = canvasRef.current;
            const cursor = cursorRef.current;
            const pointer = pointerRef.current;
            if (!canvas || !cursor) return;
            const rect = canvas.getBoundingClientRect();
            const x = pointer ? pointer.x - rect.left : -1;
            const y = pointer ? pointer.y - rect.top : -1;
            const visible = pointer && rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
            cursor.style.display = visible ? "block" : "none";
            if (!visible) return;
            const radius = drawingRef.current?.radius ?? maskBrushRadius(brushSizeRef.current, rect.width, rect.height);
            const diameter = radius * Math.min(rect.width, rect.height) * 2;
            cursor.style.width = `${diameter}px`;
            cursor.style.height = `${diameter}px`;
            cursor.style.transform = `translate3d(${x - diameter / 2}px, ${y - diameter / 2}px, 0)`;
        });
    }, []);

    useEffect(() => { scheduleCursor(); }, [brushSize, scheduleCursor]);
    useEffect(() => () => {
        if (cursorFrameRef.current !== null) cancelAnimationFrame(cursorFrameRef.current);
        cursorFrameRef.current = null;
    }, []);

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
            drawImageMask(context, { version: 1, strokes: [...(mask?.strokes || []), ...(activeStroke ? [activeStroke] : [])] }, width, height, color);
        },
        [mask, color],
    );

    useEffect(() => {
        redraw(drawingRef.current);
        const canvas = canvasRef.current;
        if (!canvas) return;
        const observer = new ResizeObserver(() => { redraw(drawingRef.current); scheduleCursor(); });
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [redraw, scheduleCursor]);

    const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>): ImageMaskPoint | null => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
    };

    const trackPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        pointerRef.current = { x: event.clientX, y: event.clientY };
        scheduleCursor();
    };

    const begin = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (event.button !== 0 || !event.isPrimary || drawingRef.current) return;
        const point = pointFromEvent(event);
        if (!point) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        trackPointer(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        const rect = event.currentTarget.getBoundingClientRect();
        drawingRef.current = { id: nanoid(), tool, radius: maskBrushRadius(brushSize, rect.width, rect.height), points: [point] };
        redraw(drawingRef.current);
    };

    const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        trackPointer(event);
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
        scheduleCursor();
    };

    const cancel = useCallback(() => {
        drawingRef.current = null;
        pointerRef.current = null;
        redraw();
        scheduleCursor();
    }, [redraw, scheduleCursor]);

    useEffect(() => {
        window.addEventListener("blur", cancel);
        return () => window.removeEventListener("blur", cancel);
    }, [cancel]);

    return (
        <div className="flex max-h-[62vh] justify-center overflow-auto rounded-xl bg-black/5 p-2">
            <div className="relative inline-flex max-w-full">
                <img src={image} alt="编辑遮罩的原图" className="block max-h-[58vh] max-w-full select-none" draggable={false} />
                <canvas ref={canvasRef} tabIndex={0} aria-label="遮罩绘制区域" className="absolute inset-0 h-full w-full cursor-none touch-none outline-none" style={{ opacity: MASK_PREVIEW_OPACITY }} onPointerEnter={trackPointer} onPointerLeave={() => { pointerRef.current = null; scheduleCursor(); }} onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={() => { if (drawingRef.current) cancel(); }} />
                <div ref={cursorRef} aria-hidden="true" data-mask-brush-cursor className="pointer-events-none absolute top-0 left-0 rounded-full" style={{ display: "none", border: "1px solid #000", boxShadow: "0 0 0 1px #fff", boxSizing: "border-box" }} />
            </div>
        </div>
    );
}
