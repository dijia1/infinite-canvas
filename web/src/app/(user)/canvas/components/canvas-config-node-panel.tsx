"use client";

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Edit3, Eye, Image as ImageIcon, Play, Video } from "lucide-react";
import { App, Button, Empty, Input, Modal, Segmented, Select } from "antd";

import { defaultConfig, reconcileProviderConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { resolveSelectedModel } from "@/lib/model-selection";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { hasImageMask } from "../image-mask/mask-utils";
import { buildGenerationConfig } from "../utils/canvas-generation-utils";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import type { NodeGenerationInput } from "./canvas-node-generation";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "../types";

type CanvasConfigNodePanelProps = {
    node: CanvasNodeData;
    inputSummary: { textCount: number; imageCount: number };
    inputs: NodeGenerationInput[];
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onTextInputChange: (nodeId: string, content: string) => void;
    onGenerate: (nodeId: string) => void;
};

export function CanvasConfigNodePanel({ node, inputSummary, inputs, onConfigChange, onTextInputChange, onGenerate }: CanvasConfigNodePanelProps) {
    const { message } = App.useApp();
    const previewContentRef = useRef<HTMLDivElement>(null);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [editingTextId, setEditingTextId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState("");
    const globalConfig = useEffectiveConfig();
	const aiStatus = useConfigStore((state) => state.status);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = node.metadata?.generationMode || "image";
    const config = buildGenerationConfig(globalConfig, node, defaultConfig);
    const chipStyle = { background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text };
    const textInputs = inputs.filter((input) => input.type === "text");
    const imageInputs = inputs.filter((input) => input.type === "image");
	const selectedImageModel = resolveSelectedModel(aiStatus?.imageModels, config.imageProviderId, aiStatus?.defaultImageModelId);
	const selectedVideoModel = resolveSelectedModel(aiStatus?.videoModels, config.videoProviderId, aiStatus?.defaultVideoModelId);
	const selectImageModel = (imageProviderId: string) => {
		if (!aiStatus) return;
		const next = reconcileProviderConfig({ ...config, imageProviderId }, aiStatus);
		onConfigChange(node.id, {
			imageProviderId: next.imageProviderId,
			imageProviderType: next.imageProviderType,
			imageRequestSchemaVersion: next.imageRequestSchemaVersion,
			providerOptions: next.providerOptions,
			quality: next.quality,
			size: next.size,
			resolution: next.resolution,
			outputFormat: next.outputFormat,
			background: next.background,
		});
	};

    const moveInput = (input: NodeGenerationInput, offset: number) => {
        const sameTypeInputs = inputs.filter((item) => item.type === input.type);
        const sameTypeIndex = sameTypeInputs.findIndex((item) => item.nodeId === input.nodeId);
        const targetInput = sameTypeInputs[sameTypeIndex + offset];
        if (!targetInput) return;
        const index = inputs.findIndex((item) => item.nodeId === input.nodeId);
        const targetIndex = inputs.findIndex((item) => item.nodeId === targetInput.nodeId);
        const next = [...inputs];
        [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
        onConfigChange(node.id, { inputOrder: next.map((input) => input.nodeId) });
        message.success("已调整输入顺序");
    };
    const startTextEdit = (input: NodeGenerationInput) => {
        setEditingTextId(input.nodeId);
        setEditingText(input.text || "");
    };
    const saveTextEdit = () => {
        if (!editingTextId) return;
        onTextInputChange(editingTextId, editingText);
        setEditingText("");
        setEditingTextId(null);
        message.success("已保存文本提示词");
    };

    useEffect(() => {
        if (!previewOpen) return;

        const stopCanvasWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
        };
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && previewContentRef.current?.contains(target)) return;
            event.preventDefault();
            event.stopPropagation();
            setPreviewOpen(false);
        };

        document.addEventListener("wheel", stopCanvasWheel, { capture: true, passive: false });
        document.addEventListener("pointerdown", closeOnOutsidePointer, { capture: true });
        return () => {
            document.removeEventListener("wheel", stopCanvasWheel, true);
            document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [previewOpen]);

    return (
        <div className="flex h-full w-full cursor-move flex-col px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }}>
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="shrink-0 text-sm font-semibold">生成配置</div>
                <div className="cursor-default" onMouseDown={(event) => event.stopPropagation()}>
                    <Segmented
                        size="small"
                        className="canvas-config-mode !rounded-md !p-0.5"
                        value={mode}
                        onChange={(value) => onConfigChange(node.id, { generationMode: value as CanvasGenerationMode })}
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

            <div className="mb-2 flex flex-wrap gap-1.5">
                <InputChip label="提示词" value={`${inputSummary.textCount} 个`} style={chipStyle} />
                <InputChip label="参考图" value={`${inputSummary.imageCount} 张`} style={chipStyle} />
                <button type="button" className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px]" style={chipStyle} onMouseDown={(event) => event.stopPropagation()} onClick={() => setPreviewOpen(true)}>
                    <Eye className="size-3.5" />
                    预览
                </button>
            </div>

            <div className="mb-2 grid min-w-0 cursor-default grid-cols-1 items-center gap-2">
                {mode === "video" ? (
                    <CanvasVideoSettingsPopover
                        config={config}
                        placement="topRight"
                        buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2"
                        onConfigChange={(key, value) => onConfigChange(node.id, key === "videoSeconds" ? { seconds: value } : { [key]: value })}
                    />
                ) : mode === "image" ? (
                    <CanvasImageSettingsPopover
                        config={config}
                        placement="topRight"
                        autoAdjustOverflow={false}
                        buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2"
                        onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
						onProviderOptionsChange={(providerOptions) => onConfigChange(node.id, { providerOptions, imageProviderType: config.imageProviderType, imageRequestSchemaVersion: config.imageRequestSchemaVersion })}
                    />
                ) : null}
            </div>

			<div className="mt-auto grid gap-2">
				<Button type="primary" className="!h-9 !w-full !cursor-pointer !rounded-lg" disabled={!inputSummary.textCount && !inputSummary.imageCount} onMouseDown={(event) => event.stopPropagation()} onClick={() => onGenerate(node.id)}>
					<span className="inline-flex items-center gap-1.5">
						<Play className="size-4" />
						<span>开始生成</span>
					</span>
				</Button>
				{mode === "image" ? <CanvasConfigModelSelect value={selectedImageModel?.id} options={aiStatus?.imageModels} onChange={selectImageModel} /> : null}
				{mode === "video" ? <CanvasConfigModelSelect value={selectedVideoModel?.id} options={aiStatus?.videoModels} onChange={(videoProviderId) => onConfigChange(node.id, { videoProviderId })} /> : null}
			</div>
            <Modal className="canvas-config-preview-modal" rootClassName="canvas-config-preview-modal-root" title="输入预览" open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={null} width={860} centered destroyOnHidden>
                <div ref={previewContentRef} className="min-h-0 flex-1 overflow-hidden" data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                    {inputs.length ? (
                        <div className="flex h-[min(66vh,580px)] flex-col gap-3 overflow-hidden">
                            <div className="shrink-0">
                                <PreviewSection title="图片提示词" count={imageInputs.length} empty="暂无图片提示词">
                                    <div className="thin-scrollbar flex gap-1.5 overflow-x-auto pb-1">
                                        {imageInputs.map((input, index) => (
                                            <ImageSortCard key={input.nodeId} input={input} imageIndex={index} imageTotal={imageInputs.length} inputs={inputs} theme={theme} onMove={moveInput} />
                                        ))}
                                    </div>
                                </PreviewSection>
                            </div>
                            <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-hidden">
                                <div className="thin-scrollbar min-h-0 overflow-y-auto pr-1.5">
                                    <PreviewSection title="文本提示词" count={textInputs.length} empty="暂无文本提示词">
                                        <div className="space-y-1.5">
                                            {textInputs.map((input, index) => (
                                                <TextSortCard key={input.nodeId} input={input} textIndex={index} textTotal={textInputs.length} inputs={inputs} theme={theme} onMove={moveInput} onEdit={startTextEdit} />
                                            ))}
                                        </div>
                                    </PreviewSection>
                                </div>
                                <div className="flex min-h-0 flex-col rounded-xl border p-2.5" style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>
                                    {editingTextId ? (
                                        <>
                                            <div className="mb-2 flex items-center justify-between">
                                                <div className="text-sm font-semibold">编辑文本提示词</div>
                                                <Button size="small" type="text" onClick={() => setEditingTextId(null)}>
                                                    收起
                                                </Button>
                                            </div>
                                            <Input.TextArea className="thin-scrollbar !flex-1 !resize-none !text-xs !leading-5" value={editingText} onChange={(event) => setEditingText(event.target.value)} />
                                            <div className="mt-2 flex justify-end gap-2">
                                                <Button size="small" onClick={() => setEditingTextId(null)}>
                                                    取消
                                                </Button>
                                                <Button size="small" type="primary" onClick={saveTextEdit}>
                                                    保存
                                                </Button>
                                            </div>
                                        </>
                                    ) : (
                                        <div className="flex h-full flex-col justify-center rounded-xl border border-dashed px-4 text-center text-xs leading-5 opacity-45" style={{ borderColor: theme.node.stroke }}>
                                            <Edit3 className="mx-auto mb-2 size-5" />
                                            选择一条文本后在这里编辑
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无提示词或参考图" className="py-8" />
                    )}
                </div>
            </Modal>
        </div>
    );
}

function CanvasConfigModelSelect({ value, options, onChange }: { value: string | undefined; options: Array<{ id: string; name: string }> | undefined; onChange: (value: string) => void }) {
	if (!options?.length) return null;
	return (
		<div className="w-full" data-canvas-no-zoom onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
			<Select
				className="!w-full"
				size="small"
				value={value}
				options={options.map((item) => ({ value: item.id, label: item.name }))}
				popupMatchSelectWidth
				popupRender={(menu) => (
					<div data-canvas-no-zoom onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
						{menu}
					</div>
				)}
				onChange={onChange}
			/>
		</div>
	);
}

function PreviewSection({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
    return (
        <section>
            <div className="sticky top-0 z-10 mb-1 flex items-center justify-between px-0.5 py-0.5 backdrop-blur-sm">
                <div className="text-xs font-semibold">{title}</div>
                <div className="text-[11px] opacity-50">{count} 个</div>
            </div>
            {count ? children : <div className="rounded-xl border border-dashed px-3 py-5 text-center text-xs opacity-45">{empty}</div>}
        </section>
    );
}

function TextSortCard({
    input,
    textIndex,
    textTotal,
    inputs,
    theme,
    onMove,
    onEdit,
}: {
    input: NodeGenerationInput;
    textIndex: number;
    textTotal: number;
    inputs: NodeGenerationInput[];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onMove: (input: NodeGenerationInput, offset: number) => void;
    onEdit: (input: NodeGenerationInput) => void;
}) {
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_72px] items-center gap-1.5 rounded-md border px-2 py-1" style={{ background: `${theme.node.fill}99`, borderColor: theme.node.stroke }}>
            <div className="min-w-0">
                <div className="truncate text-[10px] font-medium opacity-50">文本 {textIndex + 1}</div>
                <div className="truncate text-[10px] opacity-45">{input.title || `文本 ${textIndex + 1}`}</div>
                <div className="line-clamp-1 whitespace-pre-wrap break-words text-[11px] leading-4 opacity-80">{input.text}</div>
            </div>
            <div className="flex justify-end gap-1">
                <Button size="small" className="!h-6 !w-6 !min-w-6 !p-0" icon={<Edit3 className="size-3" />} onClick={() => onEdit(input)} />
                <VerticalOrderButtons index={textIndex} total={textTotal} onMove={(offset) => onMove(input, offset)} />
            </div>
        </div>
    );
}

function ImageSortCard({
    input,
    imageIndex,
    imageTotal,
    inputs,
    theme,
    onMove,
}: {
    input: NodeGenerationInput;
    imageIndex: number;
    imageTotal: number;
    inputs: NodeGenerationInput[];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onMove: (input: NodeGenerationInput, offset: number) => void;
}) {
    if (!input.image) return null;
    const masked = hasImageMask(input.image.mask);
    const inputLabel = imageIndex === 0 ? (masked ? "主图 A · 遮罩目标" : "主图 A") : masked ? "遮罩必须置于主图 A" : `参考图 ${String.fromCharCode("B".charCodeAt(0) + imageIndex - 1)}`;
    return (
        <div className="w-24 shrink-0 overflow-hidden rounded-lg border" style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>
            <div className="relative">
                <img src={input.image.dataUrl} alt={input.title} className="aspect-square w-full object-cover" />
                <span className="absolute left-1 top-1 rounded bg-black/50 px-1 py-0.5 text-[9px] font-medium text-white">{inputLabel}</span>
                <HorizontalOrderButtons index={imageIndex} total={imageTotal} onMove={(offset) => onMove(input, offset)} />
            </div>
            <div className="truncate px-1.5 py-1 text-[10px] opacity-60">{input.title || `图 ${imageIndex + 1}`}</div>
        </div>
    );
}

function VerticalOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    return (
        <>
            <Button size="small" className="!h-6 !w-6 !min-w-6 !p-0" icon={<ArrowUp className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !p-0" icon={<ArrowDown className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </>
    );
}

function HorizontalOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function InputChip({ label, value, style }: { label: string; value: string; style: CSSProperties }) {
    return (
        <div className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]" style={style}>
            <span>{label}</span>
            <span className="font-medium">{value}</span>
        </div>
    );
}
