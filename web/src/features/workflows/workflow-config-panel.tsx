"use client";

import { useLayoutEffect, useRef } from "react";
import { App, Segmented } from "antd";
import { Eye, Image as ImageIcon, Video } from "lucide-react";

import { CanvasConfigModelSelect } from "@/components/canvas-config-model-select";
import { CanvasInputChip } from "@/components/canvas-node-primitives";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "@/app/(user)/canvas/components/canvas-image-settings-popover";
import { CanvasVideoSettingsPopover } from "@/app/(user)/canvas/components/canvas-video-settings-popover";
import { defaultConfig, reconcileProviderConfig, useConfigStore } from "@/stores/use-config-store";
import { reconcileVideoConfig } from "@/lib/video-config";
import { aiConfigForWorkflowNode, workflowConfigFromAiConfig, workflowModelInputError } from "./workflow-config";
import type { WorkflowGenerationConfig, WorkflowMediaType, WorkflowNode } from "./types";

type PreviewInput = { key: string; sourceNodeId: string; type: WorkflowMediaType; text?: string; mediaId?: string; imageUrl?: string; imageStorageKey?: string; imageError?: string };

export function WorkflowConfigPanel({
    node,
    inputs,
    readOnly = false,
    onConfigChange,
    onOutputCountChange,
    onPreview,
    onModeChange,
    onLayoutHeightChange,
}: {
    node: WorkflowNode;
    inputs: PreviewInput[];
    readOnly?: boolean;
    onConfigChange: (config: WorkflowGenerationConfig) => void;
    onOutputCountChange: (count: number) => void;
    onPreview: () => void;
    onModeChange?: (mode: "image" | "video") => void;
    onLayoutHeightChange?: (height: number) => void;
}) {
    const layoutRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const layout = layoutRef.current;
        if (!layout || !onLayoutHeightChange) return;
        const syncHeight = () => onLayoutHeightChange(Math.ceil(layout.offsetHeight) + 4);
        syncHeight();
        const observer = new ResizeObserver(syncHeight);
        observer.observe(layout);
        return () => observer.disconnect();
    }, [onLayoutHeightChange]);
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const chipStyle = { background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text };
    const aiStatus = useConfigStore((state) => state.status);
    const config = aiConfigForWorkflowNode(node, defaultConfig);
    const isImage = node.type === "image_generation";
    const models = isImage ? aiStatus?.imageModels : aiStatus?.videoModels;
    const selected = models?.find((model) => model.id === node.config?.providerId);
    const inputCounts = inputs.reduce<Record<WorkflowMediaType, number>>((counts, input) => ({ ...counts, [input.type]: counts[input.type] + 1 }), { image: 0, video: 0, text: 0 });
    const modelInputError = workflowModelInputError(node.type as "image_generation" | "video_generation", inputCounts, selected);
    const updateAiConfig = (next: typeof config) => onConfigChange(workflowConfigFromAiConfig(node.type as "image_generation" | "video_generation", next));
    const selectModel = (providerId: string) => {
        if (!aiStatus) return;
        const model = models?.find((item) => item.id === providerId);
        const error = workflowModelInputError(node.type as "image_generation" | "video_generation", inputCounts, model);
        if (error) {
            message.error(error);
            return;
        }
        if (isImage) updateAiConfig(reconcileProviderConfig({ ...config, imageProviderId: providerId }, aiStatus));
        else updateAiConfig(reconcileVideoConfig({ ...config, videoProviderId: providerId }, aiStatus, true));
    };

    return (
        <div ref={layoutRef} className="flex min-w-0 w-full shrink-0 cursor-move flex-col gap-8 px-3 py-4 text-sm" style={{ color: theme.node.text }}>
            <div className="flex min-w-0 shrink-0 flex-col gap-2">
                <div className="flex shrink-0 items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <div className="shrink-0 text-sm font-semibold">生成配置</div>
                        <button
                            type="button"
                            className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px]"
                            style={chipStyle}
                            onClick={onPreview}
                            onPointerDown={(event) => {
                                if (event.button !== 1) event.stopPropagation();
                            }}
                        >
                            <Eye className="size-3.5" />
                            预览
                        </button>
                    </div>
                    <div
                        className="shrink-0 cursor-default"
                        onPointerDown={(event) => {
                            if (event.button !== 1) event.stopPropagation();
                        }}
                    >
                        <Segmented
                            size="small"
                            className="canvas-config-mode !rounded-md !p-0.5"
                            value={isImage ? "image" : "video"}
                            disabled={readOnly || !onModeChange}
                            onChange={(value) => onModeChange?.(value as "image" | "video")}
                            options={[
                                {
                                    value: "image",
                                    label: (
                                        <span className="inline-flex items-center gap-1">
                                            <ImageIcon className="size-3.5" />
                                            生图
                                        </span>
                                    ),
                                },
                                {
                                    value: "video",
                                    label: (
                                        <span className="inline-flex items-center gap-1">
                                            <Video className="size-3.5" />
                                            视频
                                        </span>
                                    ),
                                },
                            ]}
                        />
                    </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1.5">
                    <CanvasInputChip label="提示词" value={`${inputCounts.text} 个`} style={chipStyle} />
                    <CanvasInputChip label="参考图" value={`${inputCounts.image} 张`} style={chipStyle} />
                    {!isImage ? <CanvasInputChip label="参考视频" value={`${inputCounts.video} 个`} style={chipStyle} /> : null}
                </div>
            </div>
            <div inert={readOnly} className={`grid min-w-0 shrink-0 cursor-default grid-cols-1 items-center gap-2 rounded-lg border ${readOnly ? "pointer-events-none opacity-60" : ""}`} style={{ borderColor: theme.node.stroke }}>
                {isImage ? (
                    <CanvasImageSettingsPopover
                        config={config}
                        maxCount={9}
                        placement="topRight"
                        buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2"
                        onConfigChange={(key, value) => {
                            if (key === "count") onOutputCountChange(Number(value) || 1);
                            // Schema pickers also emit complete options; a second write would restore stale options.
                            else if (!selected?.imageRequestSchema) updateAiConfig({ ...config, [key]: value });
                        }}
                        onProviderOptionsChange={(providerOptions) => updateAiConfig(reconcileProviderConfig({ ...config, imageProviderType: selected?.type, providerOptions }, aiStatus))}
                    />
                ) : (
                    <CanvasVideoSettingsPopover
                        outputCount={node.outputs?.length || 1}
                        onOutputCountChange={onOutputCountChange}
                        config={config}
                        placement="topRight"
                        buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2"
                        onConfigChange={(key, value) => updateAiConfig({ ...config, [key]: value })}
                    />
                )}
            </div>
            <div
                inert={readOnly}
                className={`grid min-w-0 shrink-0 gap-2 ${readOnly ? "pointer-events-none opacity-60" : ""}`}
                onPointerDown={(event) => {
                    if (event.button !== 1) event.stopPropagation();
                }}
            >
                <CanvasConfigModelSelect value={selected?.id || node.config?.providerId} options={models} onChange={selectModel} />
            </div>
            {!models?.length ? <p className="text-xs text-amber-500">管理员尚未配置可用模型</p> : node.config?.providerId && !selected ? <p className="text-xs text-amber-500">原模型当前不可用，请重新选择</p> : null}
            {modelInputError ? <p className="text-xs text-red-500">{modelInputError}</p> : null}
        </div>
    );
}
