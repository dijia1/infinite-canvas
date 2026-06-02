"use client";

import { useEffect, useRef } from "react";

const STORAGE_KEY = "canvas-perf-debug";

declare global {
    interface Window {
        __toggleCanvasPerfDebug?: (enabled?: boolean) => boolean;
    }
}

function canDebug() {
    return process.env.NODE_ENV !== "production" && typeof window !== "undefined";
}

export function isCanvasPerfDebugEnabled() {
    if (!canDebug()) return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
}

export function logCanvasPerf(label: string, data?: Record<string, unknown>) {
    if (!isCanvasPerfDebugEnabled()) return;
    if (data) {
        console.debug(`[canvas-perf] ${label}`, data);
        return;
    }
    console.debug(`[canvas-perf] ${label}`);
}

export function useCanvasPerfDebugRegistration() {
    useEffect(() => {
        if (!canDebug()) return;

        window.__toggleCanvasPerfDebug = (enabled = true) => {
            window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
            console.info(`[canvas-perf] ${enabled ? "enabled" : "disabled"}. Reload the page to apply.`);
            return enabled;
        };

        return () => {
            if (window.__toggleCanvasPerfDebug) delete window.__toggleCanvasPerfDebug;
        };
    }, []);
}

export function useCanvasPerfRender(name: string, getData?: () => Record<string, unknown>) {
    const renderCountRef = useRef(0);
    renderCountRef.current += 1;

    useEffect(() => {
        if (!isCanvasPerfDebugEnabled()) return;
        const renderCount = renderCountRef.current;
        if (renderCount > 3 && renderCount % 20 !== 0) return;

        console.debug(`[canvas-perf] render:${name}`, {
            renderCount,
            ...(getData?.() || {}),
        });
    });
}
