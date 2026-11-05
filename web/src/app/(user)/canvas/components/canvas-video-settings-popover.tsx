"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CanvasSettingsSelect, canvasSettingsPanelPosition, type CanvasSettingsTriggerProps } from "@/components/canvas-settings-select";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { VideoSettingsPanel, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    outputCount?: number;
    onOutputCountChange?: (count: number) => void;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
} & CanvasSettingsTriggerProps;

export function CanvasVideoSettingsPopover({ config, onConfigChange, outputCount, onOutputCountChange, buttonClassName, placement = "topLeft", buttonIcon, panelHeader, defaultOpen = false, formatSummary = (summary) => summary }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(defaultOpen);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    const panel =
        open && buttonRect ? (
            <VideoSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} header={panelHeader} onConfigChange={onConfigChange} outputCount={outputCount} onOutputCountChange={onOutputCountChange} />
        ) : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button
                    size="small"
                    type="text"
                    className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"}
                    style={{ background: theme.node.fill, color: theme.node.text }}
                    icon={buttonIcon ?? <Settings2 className="size-3.5" />}
                    onClick={() => setOpen((current) => !current)}
                >
                    <span className="truncate">
                        {formatSummary(`${videoResolutionLabel(config.vquality)} · ${videoSizeLabel(config.videoSize || "")} · ${videoSecondsLabel(config.videoSeconds)}${outputCount !== undefined ? ` · ${outputCount} 个` : ""}`)}
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function VideoSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    onConfigChange,
    outputCount,
    onOutputCountChange,
    header,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasVideoSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    outputCount?: number;
    onOutputCountChange?: (count: number) => void;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    header?: ReactNode;
}) {
    const style = {
        position: "fixed",
        zIndex: 1200,
        ...canvasSettingsPanelPosition(buttonRect, { width: window.innerWidth, height: window.innerHeight }, placement),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        overflow: "visible",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            data-canvas-no-zoom
            data-canvas-settings-popup-root
            className="canvas-image-settings-popover"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div style={{ maxHeight: style.maxHeight, overflowY: "auto", padding: 18, borderRadius: "inherit" }}>
                {header}
                <VideoSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" />
                {outputCount !== undefined && onOutputCountChange ? (
                    <div className="mt-4 space-y-2">
                        <div className="text-xs" style={{ color: theme.node.muted }}>
                            生成数量
                        </div>
                        <CanvasSettingsSelect
                            aria-label="生成数量"
                            value={String(outputCount)}
                            options={Array.from({ length: 9 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 个` }))}
                            onChange={(value) => onOutputCountChange(Number(value))}
                        />
                    </div>
                ) : null}
            </div>
        </div>,
        document.body,
    );
}
