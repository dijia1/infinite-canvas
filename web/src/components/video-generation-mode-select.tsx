"use client";

import { Segmented } from "antd";
import type { AiConfig } from "@/lib/ai-config";
import { useConfigStore } from "@/stores/use-config-store";

export function VideoGenerationModeSelect({ config, readOnly, onChange }: { config: AiConfig; readOnly?: boolean; onChange: (mode: "draft" | undefined) => void }) {
    const schema = useConfigStore((s) => s.status?.videoModels?.find((m) => m.id === config.videoProviderId)?.videoRequestSchema);
    if (!schema?.supportsDraft) return null;
    if (config.videoMode === "final") return <span className="text-xs opacity-65">正式片 · 1080p · 继承样片参数</span>;
    return (
        <div className="my-1 min-w-0" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
            <Segmented
                block
                size="small"
                disabled={readOnly}
                aria-label="视频生成模式"
                value={config.videoMode || "normal"}
                options={[
                    { value: "normal", label: "普通生成" },
                    { value: "draft", label: "生成样片" },
                ]}
                onChange={(v) => onChange(v === "draft" ? "draft" : undefined)}
            />
        </div>
    );
}
