"use client";

import { useRef, type CSSProperties, type ReactNode } from "react";
import { Button } from "antd";
import { Eye } from "lucide-react";

import type { CanvasTheme } from "@/lib/canvas-theme";

// Shared compact layout for canvas and workflow configuration nodes.
export function CanvasConfigCompactCard({
    theme,
    modeSwitch,
    onPreview,
    modelSelect,
    settings,
    action,
}: {
    theme: CanvasTheme;
    modeSwitch: ReactNode;
    onPreview: () => void;
    modelSelect: ReactNode;
    settings: ReactNode;
    action?: { label: string; icon: ReactNode; disabled?: boolean; onClick: () => void };
}) {
    const pressRef = useRef({ x: 0, y: 0 });
    const style = { color: theme.node.text, "--config-compact-control": theme.node.panel, "--config-compact-stroke": theme.node.stroke, "--config-compact-muted": theme.node.muted } as CSSProperties;
    return (
        <div
            className="canvas-config-compact"
            data-canvas-wheel-zoom
            style={style}
            onMouseDownCapture={(event) => {
                pressRef.current = { x: event.clientX, y: event.clientY };
            }}
            // Controls double as drag handles here, so a press that moved the card must not also click. Keyboard clicks report detail 0.
            onClickCapture={(event) => {
                if (event.detail === 0 || !event.currentTarget.contains(event.target as Node)) return;
                if (Math.abs(event.clientX - pressRef.current.x) <= 3 && Math.abs(event.clientY - pressRef.current.y) <= 3) return;
                event.preventDefault();
                event.stopPropagation();
            }}
        >
            <div className="canvas-config-compact-layout canvas-config-view-transition">
                <div className="canvas-config-compact-title">
                    <Button size="small" className="canvas-config-compact-preview" icon={<Eye className="size-3.5" />} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={onPreview}>预览</Button>
                    {modeSwitch}
                </div>
                <div className="canvas-config-compact-model">{modelSelect}</div>
                {settings}
                {action ? <Button type="primary" className="canvas-config-compact-run" aria-label={action.label} icon={action.icon} disabled={action.disabled} onClick={action.onClick}>
                    <span>{action.label}</span>
                </Button> : null}
            </div>
        </div>
    );
}
