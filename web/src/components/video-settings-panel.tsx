"use client";

import { Switch } from "antd";
import { CanvasSettingsSelect } from "@/components/canvas-settings-select";
import { ImageSettingsTheme } from "@/components/image-settings-panel";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { resolveSelectedModel } from "@/lib/model-selection";
import { videoDurationOptions, videoSupportsAudio } from "@/lib/video-config";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";

type Props = { config: AiConfig; onConfigChange: (key: "vquality" | "videoSize" | "videoSeconds" | "generateAudio", value: string) => void; theme: CanvasTheme; showTitle?: boolean; className?: string };
export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4" }: Props) {
    const status = useConfigStore((state) => state.status);
    const schema = resolveSelectedModel(status?.videoModels, config.videoProviderId, status?.defaultVideoModelId)?.videoRequestSchema;
    const invalid = Boolean(schema && (!schema.resolutions.some((r) => r.value === config.vquality) || !schema.aspectRatios.includes(config.videoSize || "")));
    const durationOptions = videoDurationOptions(schema);
    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(e) => e.stopPropagation()}>
                {showTitle && <div className="text-sm font-medium">视频设置</div>}
                <label className="block space-y-1 text-xs">
                    <span>分辨率</span>
                    <CanvasSettingsSelect
                        className="w-full"
                        value={config.vquality || undefined}
                        placeholder="请选择分辨率"
                        options={schema?.resolutions.map((r) => ({ value: r.value, label: `${r.label} · ¥${r.price}/秒` }))}
                        onChange={(v) => onConfigChange("vquality", v)}
                    />
                </label>
                <label className="block space-y-1 text-xs">
                    <span>比例</span>
                    <CanvasSettingsSelect className="w-full" value={config.videoSize || undefined} placeholder="请选择比例" options={schema?.aspectRatios.map((value) => ({ value, label: value }))} onChange={(v) => onConfigChange("videoSize", v)} />
                </label>
                <label className="block space-y-1 text-xs">
                    <span>时长</span>
                    <CanvasSettingsSelect className="w-full" value={config.videoSeconds || String(schema?.defaultDuration || 5)} options={durationOptions} onChange={(v) => onConfigChange("videoSeconds", v)} />
                </label>
                {videoSupportsAudio(schema) ? (
                    <label className="flex items-center justify-between text-xs">
                        <span>生成音频</span>
                        <Switch checkedChildren="开" unCheckedChildren="关" size="small" checked={config.generateAudio === "true"} onChange={(v) => onConfigChange("generateAudio", String(v))} />
                    </label>
                ) : null}
                {!schema && (
                    <p role="alert" className="text-xs">
                        管理员尚未配置视频模型参数
                    </p>
                )}
                {invalid && (
                    <p role="alert" className="text-xs">
                        请选择当前模型支持的分辨率和比例
                    </p>
                )}
            </div>
        </ImageSettingsTheme>
    );
}
export function videoResolutionLabel(value: string | null) {
    return value || "选择分辨率";
}
export function videoSizeLabel(value: string) {
    return value || "选择比例";
}
export function videoSecondsLabel(value: string) {
    return `${value || "5"}s`;
}
