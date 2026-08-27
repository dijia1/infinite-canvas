"use client";

import { type ReactNode } from "react";
import { ConfigProvider } from "antd";

import { type CanvasTheme } from "@/lib/canvas-theme";
import { imageAspectOptions, imageResolutionOptions, normalizeImageResolution } from "@/lib/image-generation-config";
import { normalizeImageBackground, normalizeImageOutputFormat } from "@/lib/image-output-config";
import { normalizeImageRequestOptions, schemaOptionString, type ImageRequestOptions, type ImageRequestSchema } from "@/lib/image-request-schema";
import type { AiConfig } from "@/stores/use-config-store";

const qualityOptions = [
    { value: "auto", label: "自动" },
    { value: "high", label: "高" },
    { value: "medium", label: "中" },
    { value: "low", label: "低" },
];

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "quality" | "size" | "resolution" | "outputFormat" | "background" | "count", value: string) => void;
	onProviderOptionsChange?: (options: ImageRequestOptions) => void;
	schema?: ImageRequestSchema;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
};

export function ImageSettingsPanel({ config, onConfigChange, onProviderOptionsChange, schema, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", maxCount = 15 }: ImageSettingsPanelProps) {
	const providerOptions = normalizeImageRequestOptions(schema, config.providerOptions);
	const field = (key: string) => schema?.fields.find((item) => item.key === key);
	const fieldOptions = (key: string, fallback: readonly { value: string; label: string }[]) => field(key)?.options || fallback;
	const updateProviderOption = (key: string, value: unknown) => {
		if (!schema) return;
		const next = { ...providerOptions, [key]: value };
		if (key === "background" && value === "transparent" && next.outputFormat === "jpeg") next.outputFormat = "png";
		if (key === "outputFormat" && value === "jpeg" && next.background === "transparent") next.background = field("background")?.options?.some((item) => item.value === "auto") ? "auto" : "opaque";
		const normalized = normalizeImageRequestOptions(schema, next);
		onProviderOptionsChange?.(normalized);
		if (key === "quality" || key === "size" || key === "resolution" || key === "outputFormat" || key === "background") {
			onConfigChange(key, typeof normalized[key] === "string" ? normalized[key] : String(value));
		}
	};
    const quality = schemaOptionString(providerOptions, "quality") || config.quality || "auto";
    const count = Math.max(1, Math.min(maxCount, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = schemaOptionString(providerOptions, "size") || config.size || "auto";
    const resolution = schemaOptionString(providerOptions, "resolution") || normalizeImageResolution(config.resolution);
    const outputFormat = schemaOptionString(providerOptions, "outputFormat") || normalizeImageOutputFormat(config.outputFormat);
    const background = schemaOptionString(providerOptions, "background") || normalizeImageBackground(config.background);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">图像设置</div> : null}
                {(!schema || field("quality")) ? <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>质量</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {fieldOptions("quality", qualityOptions).map((item) => (
                            <OptionPill key={item.value} selected={quality === item.value} theme={theme} onClick={() => (schema ? updateProviderOption("quality", item.value) : onConfigChange("quality", item.value))}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </div> : null}
                {(!schema || field("resolution")) ? <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>尺寸</SettingTitle>
                    <select
                        className="h-10 w-full rounded-xl border bg-transparent px-3 text-sm outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        value={resolution}
                            onChange={(event) => (schema ? updateProviderOption("resolution", event.target.value) : onConfigChange("resolution", event.target.value))}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        {fieldOptions("resolution", imageResolutionOptions).map((item) => (
                            <option key={item.value} value={item.value}>
                                {item.label}
                            </option>
                        ))}
                    </select>
                </div> : null}
                {(!schema || field("size")) ? <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>宽高比</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {imageAspectOptions.filter((item) => fieldOptions("size", imageAspectOptions).some((option) => option.value === item.value)).map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: activeSize === item.value ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => (schema ? updateProviderOption("size", item.value) : onConfigChange("size", item.value))}
                            >
                                <AspectIcon type={item.icon} width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.label}</span>
                            </button>
                        ))}
                    </div>
                </div> : null}
                {(!schema || field("outputFormat")) ? <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>输出格式</SettingTitle>
                    <div className="grid grid-cols-2 gap-2.5">
                        {fieldOptions("outputFormat", [{ value: "jpeg", label: "JPEG" }, { value: "png", label: "PNG" }]).map((item) => (
                            <OptionPill
								key={item.value}
								selected={outputFormat === item.value}
								theme={theme}
								onClick={() => {
									if (schema) updateProviderOption("outputFormat", item.value);
									else {
										onConfigChange("outputFormat", item.value);
										if (item.value === "jpeg" && background === "transparent") onConfigChange("background", "auto");
									}
								}}
							>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </div> : null}
                {(!schema || field("background")) ? <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>背景</SettingTitle>
                    <div className="grid grid-cols-3 gap-2.5">
                        {fieldOptions("background", [
                            { value: "auto", label: "自动" },
                            { value: "opaque", label: "不透明" },
                            { value: "transparent", label: "透明" },
                        ]).map((item) => (
                            <OptionPill
                                key={item.value}
                                selected={background === item.value}
                                theme={theme}
								onClick={() => {
									if (schema) updateProviderOption("background", item.value);
									else {
										if (item.value === "transparent" && outputFormat === "jpeg") onConfigChange("outputFormat", "png");
										onConfigChange("background", item.value);
									}
								}}
                            >
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </div> : null}
				{schema?.fields.filter((item) => !["quality", "size", "resolution", "outputFormat", "background"].includes(item.key)).map((item) => (
					<SchemaFieldControl key={item.key} field={item} value={providerOptions[item.key]} theme={theme} onChange={(value) => updateProviderOption(item.key, value)} />
				))}
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>生成张数</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {[1, 3, 5].map((value) => (
                            <OptionPill key={value} selected={count === value} theme={theme} onClick={() => onConfigChange("count", String(value))}>
                                {value} 张
                            </OptionPill>
                        ))}
                        <CountInput value={count} max={maxCount} theme={theme} onChange={(value) => onConfigChange("count", String(value || 1))} />
                    </div>
                </div>
            </div>
        </ImageSettingsTheme>
    );
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    return (
        <ConfigProvider
            theme={{
                token: { colorBgContainer: theme.toolbar.panel, colorBgElevated: theme.toolbar.panel, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel },
                components: { Button: { defaultBg: theme.toolbar.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text } },
            }}
        >
            {children}
        </ConfigProvider>
    );
}

export function imageQualityLabel(value: string) {
    return ({ auto: "自动", high: "高", medium: "中", low: "低" } as Record<string, string>)[value] || value;
}

export function imageSizeLabel(size: string) {
    return imageAspectOptions.find((item) => item.value === size)?.label || size;
}

export function imageResolutionLabel(resolution: string) {
    return imageResolutionOptions.find((item) => item.value === normalizeImageResolution(resolution))?.label || "1K";
}

export function imageOutputFormatLabel(value: string) {
    return normalizeImageOutputFormat(value).toUpperCase();
}

export function imageBackgroundLabel(value: unknown) {
    return ({ auto: "自动", opaque: "不透明", transparent: "透明" } as Record<string, string>)[normalizeImageBackground(value)] || "自动";
}

function SchemaFieldControl({ field, value, theme, onChange }: { field: import("@/lib/image-request-schema").ImageRequestField; value: unknown; theme: CanvasTheme; onChange: (value: unknown) => void }) {
	if (field.type === "boolean") {
		return (
			<div className="space-y-2.5">
				<SettingTitle color={theme.node.muted}>{field.label}</SettingTitle>
				<div className="grid grid-cols-2 gap-2.5">
					<OptionPill selected={value === true} theme={theme} onClick={() => onChange(true)}>开启</OptionPill>
					<OptionPill selected={value === false} theme={theme} onClick={() => onChange(false)}>关闭</OptionPill>
				</div>
			</div>
		);
	}
	if (field.type === "select") {
		return (
			<div className="space-y-2.5">
				<SettingTitle color={theme.node.muted}>{field.label}</SettingTitle>
				<div className="grid grid-cols-2 gap-2.5">
					{field.options?.map((option) => <OptionPill key={option.value} selected={value === option.value} theme={theme} onClick={() => onChange(option.value)}>{option.label}</OptionPill>)}
				</div>
			</div>
		);
	}
	return (
		<div className="space-y-2.5">
			<SettingTitle color={theme.node.muted}>{field.label}</SettingTitle>
			<input
				type={field.type === "number" ? "number" : "text"}
				className="h-10 w-full rounded-xl border bg-transparent px-3 text-sm outline-none"
				style={{ borderColor: theme.node.stroke, color: theme.node.text }}
				value={typeof value === "string" || typeof value === "number" ? value : ""}
				onChange={(event) => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)}
				onMouseDown={(event) => event.stopPropagation()}
			/>
		</div>
	);
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function CountInput({ value, max, theme, onChange }: { value: number; max: number; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="col-span-2 flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input
                type="number"
                min={1}
                max={max}
                className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{ color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                value={value || ""}
                onChange={(event) => onChange(Number(event.target.value) || null)}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function AspectIcon({ type, width, height, color }: { type: string; width: number; height: number; color: string }) {
    if (type === "auto") return null;
    const ratio = width / Math.max(1, height);
    const boxWidth = ratio >= 1 ? 24 : Math.max(10, 24 * ratio);
    const boxHeight = ratio >= 1 ? Math.max(10, 24 / ratio) : 24;
    return (
        <span className="grid h-7 w-9 place-items-center">
            <span className="border-2" style={{ width: boxWidth, height: boxHeight, borderColor: color }} />
        </span>
    );
}

function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}
