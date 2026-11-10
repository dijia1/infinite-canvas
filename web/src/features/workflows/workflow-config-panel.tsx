"use client";

import { App, Segmented } from "antd";
import type { CSSProperties } from "react";
import { Eye, Image as ImageIcon, Video } from "lucide-react";
import { CanvasConfigModelSelect } from "@/components/canvas-config-model-select";
import { CanvasConfigFullFrame } from "@/components/canvas-config-full-frame";
import { CanvasConfigCompactCard } from "@/components/canvas-config-compact-card";
import { CanvasInputChip } from "@/components/canvas-node-primitives";
import { shortSettingsSummary } from "@/components/canvas-settings-select";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "@/features/canvas/components/canvas-image-settings-popover";
import { CanvasVideoSettingsPopover } from "@/features/canvas/components/canvas-video-settings-popover";
import { defaultConfig, reconcileProviderConfig, useConfigStore } from "@/stores/use-config-store";
import { reconcileVideoConfig } from "@/lib/video-config";
import { aiConfigForWorkflowNode, workflowConfigFromAiConfig, workflowModelInputError } from "./workflow-config";
import type { WorkflowGenerationConfig, WorkflowMediaType, WorkflowNode } from "./types";

type PreviewInput = { key: string; sourceNodeId: string; type: WorkflowMediaType; text?: string; mediaId?: string; imageUrl?: string; imageStorageKey?: string; imageError?: string };

export function WorkflowConfigPanel({
    node,
    inputs,
    readOnly = false,
    compact = false,
    onConfigChange,
    onOutputCountChange,
    onPreview,
    onModeChange,
}: {
    node: WorkflowNode;
    inputs: PreviewInput[];
    readOnly?: boolean;
    compact?: boolean;
    onConfigChange: (config: WorkflowGenerationConfig) => void;
    onOutputCountChange: (count: number) => void;
    onPreview: () => void;
    onModeChange?: (mode: "image" | "video") => void;
}) {
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
    const modeSwitch = (
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
    );
    const modelSelect = (
        <div inert={readOnly} className={readOnly ? "pointer-events-none opacity-60" : ""}>
            <CanvasConfigModelSelect value={selected?.id || node.config?.providerId} options={models} onChange={selectModel} />
        </div>
    );
    const ModeIcon = isImage ? ImageIcon : Video;
    const settings = (
        <span inert={readOnly} className={`inline-flex min-w-0 w-full [&>span]:h-full [&>span]:w-full ${readOnly ? "pointer-events-none opacity-60" : ""}`}>
            {isImage ? (
                <CanvasImageSettingsPopover
                    config={config}
                    compact={compact}
                    maxCount={9}
                    placement="topRight"
                    buttonClassName={compact ? "canvas-config-compact-settings" : "canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2"}
                    {...(compact
                        ? {
                              buttonIcon: (
                                  <ModeIcon className="size-3.5" />
                              ),
                          }
                        : {})}
                    onConfigChange={(key, value) => {
                        if (key === "count") onOutputCountChange(Number(value) || 1);
                        else if (!selected?.imageRequestSchema) updateAiConfig({ ...config, [key]: value });
                    }}
                    onProviderOptionsChange={(providerOptions) => updateAiConfig(reconcileProviderConfig({ ...config, imageProviderType: selected?.type, providerOptions }, aiStatus))}
                />
            ) : (
                <CanvasVideoSettingsPopover
                    config={config}
                    outputCount={node.outputs?.length || 1}
                    onOutputCountChange={onOutputCountChange}
                    placement="topRight"
                    buttonClassName={compact ? "canvas-config-compact-settings" : "canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2"}
                    {...(compact
                        ? {
                              formatSummary: shortSettingsSummary,
                              buttonIcon: (
                                  <ModeIcon className="size-3.5" />
                              ),
                          }
                        : {})}
                    onConfigChange={(key, value) => updateAiConfig({ ...config, [key]: value })}
                />
            )}
        </span>
    );
    if (compact) return <CanvasConfigCompactCard theme={theme} modeSwitch={modeSwitch} onPreview={onPreview} modelSelect={modelSelect} settings={settings} />;
    return (
        <CanvasConfigFullFrame width={node.width || 360} height={node.height || 274} style={{ color: theme.node.text, "--config-compact-control": theme.node.panel } as CSSProperties}>
            <div className="flex min-w-0 shrink-0 flex-col gap-2">
                <div className="flex shrink-0 items-center justify-between gap-2">
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
                    {modeSwitch}
                </div>
                <div className="flex shrink-0 flex-wrap gap-1.5">
                    <CanvasInputChip label="提示词" value={`${inputCounts.text} 个`} style={chipStyle} />
                    <CanvasInputChip label="参考图" value={`${inputCounts.image} 张`} style={chipStyle} />
                    {!isImage ? <CanvasInputChip label="参考视频" value={`${inputCounts.video} 个`} style={chipStyle} /> : null}
                </div>
            </div>
            <div className="grid min-w-0 shrink-0 gap-2">
                {modelSelect}
                {settings}
            </div>
            {!models?.length ? <p className="text-xs text-amber-500">管理员尚未配置可用模型</p> : node.config?.providerId && !selected ? <p className="text-xs text-amber-500">原模型当前不可用，请重新选择</p> : null}
            {modelInputError ? <p className="text-xs text-red-500">{modelInputError}</p> : null}
        </CanvasConfigFullFrame>
    );
}
