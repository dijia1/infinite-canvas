"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { createImageDownloadQueue, type ImageDownloadQueue } from "@/services/image-download";

const serverIdle = () => false;
const serverState = () => null;

export function useImageDownloads(scope: string) {
    const queue = useMemo(() => createImageDownloadQueue(), [scope]);
    useEffect(() => () => queue.cancel(), [queue]);
    // Only start/end updates reach the editor; per-image progress stays below.
    const busy = useSyncExternalStore(queue.subscribe, queue.isBusy, serverIdle);
    return { queue, busy };
}

export function ImageDownloadProgress({ queue }: { queue: ImageDownloadQueue }) {
    const state = useSyncExternalStore(queue.subscribe, queue.getSnapshot, serverState);
    const theme = canvasThemes[useThemeStore(s => s.theme)];
    const busy = state?.phase === "reading" || state?.phase === "waiting";
    useEffect(() => {
        if (!state || busy || state.failed) return;
        const timer = setTimeout(queue.dismiss, 5000);
        return () => clearTimeout(timer);
    }, [queue, busy, state]);
    if (!state) return null;
    const title = busy ? "批量下载" : state.phase === "cancelled" ? "下载已停止" : `已发起 ${state.issued} 张图片下载${state.failed ? `，${state.failed} 张失败` : ""}`;
    return <section aria-label="图片下载进度" className="absolute bottom-24 right-4 z-[75] w-72 max-w-[calc(100%-2rem)] rounded-lg border p-3 shadow-sm" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} onPointerDown={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2">
            <div role="status" className="text-xs font-medium leading-5">{title}</div>
            {!busy ? <button type="button" aria-label="关闭下载进度" onClick={queue.dismiss} className="grid size-5 shrink-0 place-items-center opacity-60 hover:opacity-100"><X className="size-3.5" /></button> : null}
        </div>
        <div className="mt-2 text-xs" style={{ color: theme.node.muted }}>已处理 {state.processed}/{state.total} · 已发起 {state.issued} · 失败 {state.failed}</div>
        <div role="progressbar" aria-label="图片下载处理进度" aria-valuemin={0} aria-valuemax={state.total} aria-valuenow={state.processed} className="mt-2 h-1 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
            <div className="h-full rounded-full bg-[#2f80ff]" style={{ width: `${state.processed / state.total * 100}%` }} />
        </div>
        {busy ? <div className="mt-2 truncate text-xs" title={state.currentFilename} style={{ color: theme.node.muted }}>{state.phase === "reading" ? `正在读取 ${state.currentFilename}` : "等待发起下一张下载"}</div> : state.failed ? <div className="mt-2 break-words text-xs text-amber-600 dark:text-amber-400">{state.error}</div> : null}
        {busy || state.failed ? <div className="mt-2 flex justify-end gap-2">
            {busy ? <button type="button" onClick={queue.cancel} className="rounded border px-2 py-1 text-xs" style={{ borderColor: theme.toolbar.border }}>取消</button> : <button type="button" onClick={() => void queue.retry()} className="rounded border px-2 py-1 text-xs" style={{ borderColor: theme.toolbar.border }}>重试失败项</button>}
        </div> : null}
    </section>;
}
