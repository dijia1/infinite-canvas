"use client";

import { CircleAlert, Clock3, LoaderCircle, RefreshCw } from "lucide-react";
import { generationTaskPresentation, type GenerationTaskIssue } from "@/lib/generation-task-state";

export function GenerationTaskFeedback({
    status,
    error,
    issue,
    connectionError,
    busy,
    confirmingRetry,
    onResume,
    onRegenerate,
    onReconnect,
}: {
    status?: string;
    error?: string;
    issue?: GenerationTaskIssue;
    connectionError?: string;
    busy?: boolean;
    confirmingRetry?: boolean;
    onResume?: () => void;
    onRegenerate?: () => void;
    onReconnect?: () => void;
}) {
    const view = generationTaskPresentation(status, error, issue, connectionError);
    const running = ["loading", "preparing", "queued", "submitting", "running", "saving", "ready", "claimed"].includes(status || "");
    const actions = connectionError
        ? [{ label: "重新连接", action: onReconnect }]
        : status === "paused"
          ? [
                { label: "恢复查询", action: onResume },
                { label: confirmingRetry ? "确认重试" : "重新生成", action: onRegenerate },
            ]
          : status === "uncertain"
            ? [
                  { label: "刷新状态", action: onReconnect },
                  { label: confirmingRetry ? "确认重试" : "重新生成", action: onRegenerate },
              ]
            : status === "failed"
              ? [{ label: confirmingRetry ? "确认重试" : "重新生成", action: onRegenerate }]
              : [];
    return (
        <div role="status" className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 py-3 text-center">
            {running && !connectionError ? <LoaderCircle className="size-6 animate-spin" /> : view.tone === "normal" ? <Clock3 className="size-6" /> : <CircleAlert className={`size-6 ${view.tone === "error" ? "text-red-400" : "text-amber-400"}`} />}
            <span className={`text-sm ${view.tone === "error" ? "text-red-400" : view.tone === "warning" ? "text-amber-400" : ""}`}>{view.title}</span>
            {view.message ? <span className="line-clamp-3 text-xs leading-5 opacity-80">{view.message}</span> : null}
            <div className="flex flex-wrap justify-center gap-2">
                {actions
                    .filter((item) => item.action)
                    .map((item) => (
                        <button
                            key={item.label}
                            type="button"
                            disabled={busy}
                            className="inline-flex items-center gap-1 rounded-lg border border-current/25 px-3 py-1.5 text-xs disabled:opacity-50"
                            onPointerDown={(event) => {
                                if (event.button !== 1) event.stopPropagation();
                            }}
                            onClick={(event) => {
                                event.stopPropagation();
                                item.action?.();
                            }}
                        >
                            <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
                            {item.label}
                        </button>
                    ))}
            </div>
        </div>
    );
}
