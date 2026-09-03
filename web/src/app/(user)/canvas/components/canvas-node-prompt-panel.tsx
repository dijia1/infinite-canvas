"use client";

import { useEffect, useState } from "react";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { Button } from "antd";

import { defaultConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { buildGenerationConfig } from "../utils/canvas-generation-utils";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "../types";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onGenerate, onImageSettingsOpenChange }: CanvasNodePromptPanelProps) {
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = defaultMode(node.type);
    const config = buildGenerationConfig(globalConfig, node, defaultConfig);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const shouldPersistPrompt = node.type === CanvasNodeType.Image || !isEditingExistingContent;
    const [prompt, setPrompt] = useState(shouldPersistPrompt ? node.metadata?.prompt || "" : "");

    useEffect(() => {
        setPrompt(shouldPersistPrompt ? node.metadata?.prompt || "" : "");
    }, [node.id, node.metadata?.prompt, shouldPersistPrompt]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (shouldPersistPrompt) onPromptChange(node.id, value);
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text || isRunning) return;
        onGenerate(node.id, mode, text);
        if (node.type !== CanvasNodeType.Image) setPrompt("");
    };

    if (node.type === CanvasNodeType.Text) return null;

    return (
        <div
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <textarea
                value={prompt}
                onChange={(event) => updatePrompt(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.shiftKey) return;
                    event.preventDefault();
                    submit();
                }}
                className="thin-scrollbar h-24 w-full resize-none rounded-xl border px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}
                placeholder={mode === "video" ? "描述要生成的视频内容" : hasImageContent ? "请输入你想要把这张图修改成什么" : "描述要生成的图片内容"}
            />

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    {mode === "image" ? (
                        <>
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
								onProviderOptionsChange={(providerOptions) => onConfigChange(node.id, { providerOptions, imageProviderType: config.imageProviderType, imageRequestSchemaVersion: config.imageRequestSchemaVersion })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <CanvasVideoSettingsPopover
                                config={config}
                                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "videoSeconds" ? { seconds: value } : { [key]: value })}
                            />
                        </>
                    ) : null}
                </div>
                <Button type="primary" className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3" disabled={isRunning || !prompt.trim()} onClick={submit} aria-label="生成">
                    {isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                </Button>
            </div>
        </div>
    );
}

export function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Video ? "video" : "image";
}
