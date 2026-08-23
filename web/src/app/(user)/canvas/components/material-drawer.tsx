"use client";

import type { ReactNode, TransitionEvent } from "react";
import { useEffect, useState } from "react";
import { X } from "lucide-react";

export function MaterialDrawer({
    open,
    title,
    closeLabel,
    onClose,
    onPointerEnter,
    onPointerLeave,
    children,
}: {
    open: boolean;
    title: string;
    closeLabel: string;
    onClose: () => void;
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    children: ReactNode;
}) {
    const [mounted, setMounted] = useState(open);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (!open) {
            setVisible(false);
            return;
        }
        setMounted(true);
        let visibleFrame: number | undefined;
        const mountFrame = window.requestAnimationFrame(() => {
            visibleFrame = window.requestAnimationFrame(() => setVisible(true));
        });
        return () => {
            window.cancelAnimationFrame(mountFrame);
            if (visibleFrame) window.cancelAnimationFrame(visibleFrame);
        };
    }, [open]);

    const handleTransitionEnd = (event: TransitionEvent<HTMLElement>) => {
        if (event.currentTarget !== event.target || open) return;
        setMounted(false);
    };

    if (!mounted) return null;

    return (
        <aside
            className={`fixed bottom-0 left-0 top-16 z-[90] flex w-[min(26rem,calc(100vw-2rem))] flex-col border-r border-stone-200 bg-background/95 shadow-2xl backdrop-blur-xl transition-[translate,opacity] duration-200 ease-out dark:border-stone-800 ${visible ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-full opacity-0"}`}
            data-canvas-no-zoom
            aria-hidden={!open}
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
            onTransitionEnd={handleTransitionEnd}
        >
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-stone-200 px-4 dark:border-stone-800">
                <h2 className="text-base font-medium">{title}</h2>
                <button
                    type="button"
                    className="inline-flex size-8 items-center justify-center rounded-md text-stone-500 transition hover:bg-stone-100 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
                    onClick={onClose}
                    aria-label={closeLabel}
                >
                    <X className="size-4" />
                </button>
            </div>
            {children}
        </aside>
    );
}
