"use client";

import { cn } from "@/lib/utils";

type Props = {
    stage: "uploading" | "verifying" | "failed";
    progress?: number;
    error?: string;
    onRetry?: () => void;
    onCancel?: () => void;
    className?: string;
};

export function CanvasMediaUploadStatus({ stage, progress = 0, error, onRetry, onCancel, className }: Props) {
    const failed = stage === "failed";
    const percent = stage === "verifying" ? 100 : progress;
    return (
        <div
            role="status"
            data-canvas-upload-status={stage}
            className={cn(
                "pointer-events-none absolute inset-x-3 bottom-3 z-20 rounded-lg border px-2.5 py-2 text-[11px] text-white shadow-sm backdrop-blur-sm",
                failed ? "border-red-300/70 bg-red-950/85 text-red-100" : "border-black/15 bg-black/65",
                className,
            )}
        >
            <div className="flex items-center justify-between gap-2 font-medium">
                <span className="min-w-0 truncate">{failed ? "上传失败" : stage === "verifying" ? "正在完成上传…" : "正在上传"}</span>
                <div className="pointer-events-auto flex shrink-0 items-center gap-2" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                    {!failed && <span>{percent}%</span>}
                    {failed && onRetry && (
                        <button type="button" className="rounded border border-current/50 px-1.5 py-0.5 transition hover:bg-white/15" onClick={onRetry}>
                            重试
                        </button>
                    )}
                    {onCancel && (
                        <button type="button" className="rounded border border-current/50 px-1.5 py-0.5 transition hover:bg-white/15" onClick={onCancel}>
                            取消上传
                        </button>
                    )}
                </div>
            </div>
            {!failed && (
                <div role="progressbar" aria-label="上传进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/25">
                    <div className="h-full rounded-full bg-white transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
                </div>
            )}
            {failed && error && (
                <div role="alert" className="mt-1 break-words">
                    {error}
                </div>
            )}
        </div>
    );
}
