"use client";

import { useEffect, useRef } from "react";

import type { ImageMask } from "@/types/image";

import { drawImageMask } from "./mask-utils";

const overlayColor = "rgba(239, 68, 68, 0.3)";

export function CanvasImageMaskOverlay({ mask }: { mask: ImageMask | undefined }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const draw = () => {
            const rect = canvas.getBoundingClientRect();
            const width = Math.max(1, Math.round(rect.width));
            const height = Math.max(1, Math.round(rect.height));
            const ratio = Math.max(1, window.devicePixelRatio || 1);
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
            const context = canvas.getContext("2d");
            if (!context) return;
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
            drawImageMask(context, mask, width, height, overlayColor);
        };

        draw();
        const observer = new ResizeObserver(draw);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [mask]);

    return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden="true" />;
}
