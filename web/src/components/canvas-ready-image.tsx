"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";

type Props = {
    src?: string;
    alt: string;
    className?: string;
    loading?: ReactNode;
    error?: string;
    errorFallback?: ReactNode;
    onRetry?: () => void;
    onReady?: (image: HTMLImageElement) => void;
};

// Keep the last decoded variant visible while its replacement is loading.
// The hidden candidate becomes the visible DOM image, so decoding needs no
// extra fetch and the resource owner can release the old URL after commit.
export function CanvasReadyImage({ src, alt, className = "object-contain", loading, error, errorFallback, onRetry, onReady }: Props) {
    const [displayed, setDisplayed] = useState<string>();
    const [failed, setFailed] = useState<string>();
    const [attempt, setAttempt] = useState(0);
    const candidate = useRef<HTMLImageElement>(null);
    const readyCallback = useRef(onReady);
    readyCallback.current = onReady;

    useEffect(() => {
        const image = candidate.current;
        if (!src || !image || displayed === src) return;
        let active = true;
        let started = false;
        const current = () => active && candidate.current === image;
        const fail = () => { if (current()) setFailed(src); };
        const loaded = async () => {
            if (started) return;
            started = true;
            try {
                if (typeof image.decode === "function") await image.decode();
                if (!image.naturalWidth || !image.naturalHeight) throw new Error("Invalid image");
                if (current()) {
                    setFailed(undefined);
                    setDisplayed(src);
                }
            } catch { fail(); }
        };
        image.addEventListener("load", loaded);
        image.addEventListener("error", fail);
        if (image.complete) {
            if (image.naturalWidth) void loaded();
            else fail();
        }
        return () => {
            active = false;
            image.removeEventListener("load", loaded);
            image.removeEventListener("error", fail);
        };
    }, [src, attempt, displayed]);

    useEffect(() => {
        if (displayed && displayed === src && candidate.current) readyCallback.current?.(candidate.current);
    }, [displayed, src]);

    const hasError = Boolean(error || (src && failed === src));
    const sources = [...new Set([displayed, src].filter((value): value is string => Boolean(value)))];
    return (
        <div className="relative h-full w-full" data-image-display-state={hasError ? "error" : displayed === src && src ? "ready" : "loading"}>
            {sources.map((url) => (
                <img
                    key={`${attempt}:${url}`}
                    ref={url === src ? candidate : undefined}
                    src={url}
                    alt={url === displayed ? alt : ""}
                    aria-hidden={url !== displayed}
                    decoding="async"
                    draggable={false}
                    className={`pointer-events-none absolute inset-0 block h-full w-full select-none ${className}`}
                    style={{ visibility: url === displayed ? "visible" : "hidden" }}
                />
            ))}
            {hasError ? errorFallback ?? (
                <div role="alert" className={`absolute flex items-center justify-center gap-2 bg-stone-100/90 px-3 text-center text-xs text-stone-600 dark:bg-stone-900/90 dark:text-stone-300 ${displayed ? "inset-x-2 bottom-2 rounded py-2" : "inset-0 flex-col"}`}>
                    <span>图片加载失败</span>
                    <button type="button" className="inline-flex items-center gap-1 rounded border px-2 py-1" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => {
                        event.stopPropagation();
                        setFailed(undefined);
                        setAttempt((value) => value + 1);
                        onRetry?.();
                    }}>
                        <RefreshCw className="size-3" />重新加载
                    </button>
                </div>
            ) : !displayed ? loading ?? (
                <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-stone-100 text-stone-500 dark:bg-stone-900 dark:text-stone-400">
                    <span className="size-10 animate-spin rounded-full border-2 border-current border-t-transparent opacity-60" />
                    <span className="text-[10px] tracking-[0.2em]">图片加载中</span>
                </div>
            ) : null}
        </div>
    );
}
