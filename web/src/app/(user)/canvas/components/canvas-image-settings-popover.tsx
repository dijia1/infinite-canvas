"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { ImageSettingsPanel, imageBackgroundLabel, imageOutputFormatLabel, imageQualityLabel, imageResolutionLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { normalizeImageRequestOptions, schemaOptionString, type ImageRequestOptions } from "@/lib/image-request-schema";
import { resolveSelectedModel } from "@/lib/model-selection";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { useConfigStore } from "@/stores/use-config-store";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
	onProviderOptionsChange?: (options: ImageRequestOptions) => void;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    autoAdjustOverflow?: boolean;
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onProviderOptionsChange, onOpenChange, buttonClassName, placement = "topLeft" }: CanvasImageSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
	const aiStatus = useConfigStore((state) => state.status);
	const selectedImageModel = resolveSelectedModel(aiStatus?.imageModels, config.imageProviderId, aiStatus?.defaultImageModelId);
	const schema = selectedImageModel?.imageRequestSchema || (config.imageProviderType === aiStatus?.imageProviderType ? aiStatus?.imageRequestSchema : undefined);
	const options = normalizeImageRequestOptions(schema, config.providerOptions);
    const quality = schemaOptionString(options, "quality") || config.quality || "auto";
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = schemaOptionString(options, "size") || config.size || "auto";
    const updateOpen = (nextOpen: boolean) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
    };

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
            onOpenChange?.(false);
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
    }, [onOpenChange, open]);

    const panel = open && buttonRect ? <ImageSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} schema={schema} onConfigChange={onConfigChange} onProviderOptionsChange={onProviderOptionsChange} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button
                    size="small"
                    type="text"
                    className={buttonClassName || "!h-8 !max-w-[180px] !justify-start !rounded-full !px-2.5"}
                    style={{ background: theme.node.fill, color: theme.node.text }}
                    icon={<Settings2 className="size-3.5" />}
                    onClick={() => updateOpen(!open)}
                >
                    <span className="truncate">
						{imageSettingsSummary(config, schema, options, quality, activeSize, count)}
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function ImageSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
	schema,
    onConfigChange,
	onProviderOptionsChange,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasImageSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
	schema?: import("@/lib/image-request-schema").ImageRequestSchema;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
	onProviderOptionsChange?: (options: ImageRequestOptions) => void;
}) {
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            data-canvas-no-zoom
            className="canvas-image-settings-popover"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onWheelCapture={(event) => event.stopPropagation()}
        >
			<ImageSettingsPanel config={config} schema={schema} onConfigChange={(key, value) => onConfigChange(key, value)} onProviderOptionsChange={onProviderOptionsChange} theme={theme} className="space-y-4" />
        </div>,
        document.body,
    );
}

function imageSettingsSummary(config: AiConfig, schema: import("@/lib/image-request-schema").ImageRequestSchema | undefined, options: ImageRequestOptions, quality: string, size: string, count: number) {
	if (!schema) return `${imageQualityLabel(quality)} · ${imageSizeLabel(size)} · ${imageResolutionLabel(config.resolution)} · ${imageOutputFormatLabel(config.outputFormat)} · ${imageBackgroundLabel(config.background)} · ${count} 张`;
	const fields = schema.fields
		.map((field) => {
			const value = options[field.key];
			if (value === undefined) return "";
			if (typeof value === "boolean") return `${field.label}${value ? "开" : "关"}`;
			return field.options?.find((item) => item.value === value)?.label || String(value);
		})
		.filter(Boolean);
	return [...fields, `${count} 张`].join(" · ");
}
