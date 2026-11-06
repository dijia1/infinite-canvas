"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ImageIcon, Video } from "lucide-react";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { GeneratedResultDetails } from "../utils/canvas-generated-result";

export function CanvasNodeResultPanel({ details, theme, mediaType = "image" }: { details: GeneratedResultDetails; theme: CanvasTheme; mediaType?: "image" | "video" }) {
    const [copyStatus, setCopyStatus] = useState("");
    useEffect(() => setCopyStatus(""), [details.prompt]);
    const copyPrompt = async () => {
        try {
            await navigator.clipboard.writeText(details.prompt);
            setCopyStatus("提示词已复制");
        } catch {
            setCopyStatus("复制失败，请选中文字复制");
        }
    };
    return (
        <section
            aria-label="生成结果信息"
            className="rounded-2xl border p-3"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={event => event.stopPropagation()}
            onPointerDown={event => event.stopPropagation()}
            onWheel={event => event.stopPropagation()}
            onKeyDown={event => event.stopPropagation()}
        >
            <div className="relative rounded-xl border py-2 pl-3 pr-9" style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>
                <div tabIndex={0} aria-label="生成提示词，只读" className="thin-scrollbar max-h-24 min-h-12 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-5 select-text">
                    {details.prompt || "未记录提示词"}
                </div>
                <button type="button" aria-label="复制提示词" title={copyStatus || "复制提示词"} disabled={!details.prompt} onClick={copyPrompt} className="absolute top-2 right-2 rounded p-1 opacity-70 hover:opacity-100 disabled:opacity-30" style={{ color: theme.node.muted }}>
                    {copyStatus === "提示词已复制" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </button>
            </div>
            <div className="my-2 flex min-w-0 items-center gap-2 text-xs">
                <span style={{ color: theme.node.muted }}>模型</span>{mediaType === "video" ? <Video className="size-3.5 shrink-0" /> : <ImageIcon className="size-3.5 shrink-0" />}
                <span className="truncate" title={details.model}>{details.model}</span>
            </div>
            <div aria-label="生成参数" className="thin-scrollbar flex items-center justify-between gap-3 overflow-x-auto border-t pt-2 text-[11px]" style={{ borderColor: theme.node.stroke }}>
                {details.parameters.map(parameter => <div key={parameter.label} className="flex shrink-0 items-center gap-1.5 whitespace-nowrap"><span style={{ color: theme.node.muted }}>{parameter.label}</span><span>{parameter.value}</span></div>)}
            </div>
            <span role="status" className="sr-only">{copyStatus}</span>
        </section>
    );
}
