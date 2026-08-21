"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";

export function MaterialDrawer({
    title,
    closeLabel,
    onClose,
    onPointerEnter,
    onPointerLeave,
    children,
}: {
    title: string;
    closeLabel: string;
    onClose: () => void;
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    children: ReactNode;
}) {
    return (
        <aside
            className="fixed bottom-0 left-0 top-16 z-[90] flex w-[min(26rem,calc(100vw-2rem))] flex-col border-r border-stone-200 bg-background/95 shadow-2xl backdrop-blur-xl dark:border-stone-800"
            data-canvas-no-zoom
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
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
