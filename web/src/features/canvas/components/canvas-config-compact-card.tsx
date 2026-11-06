"use client";

import { useRef, type CSSProperties, type ReactNode } from "react";
import { Play } from "lucide-react";
import { Button } from "antd";

import type { CanvasTheme } from "@/lib/canvas-theme";

// CanvasNode picks the form (controls or icons) through data-config-form, and globals.css lays each one out.
export function CanvasConfigCompactCard({ theme, modeSwitch, modelSelect, settings, generateDisabled, onGenerate }: {
    theme: CanvasTheme;
    modeSwitch: ReactNode;
    modelSelect: ReactNode;
    settings: ReactNode;
    generateDisabled: boolean;
    onGenerate: () => void;
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
                    {modeSwitch}
                </div>
                <div className="canvas-config-compact-model">{modelSelect}</div>
                {settings}
                <Button type="primary" className="canvas-config-compact-run" aria-label="开始生成" icon={<Play className="size-3.5" />} disabled={generateDisabled} onClick={onGenerate}>
                    <span>开始生成</span>
                </Button>
            </div>
        </div>
    );
}
