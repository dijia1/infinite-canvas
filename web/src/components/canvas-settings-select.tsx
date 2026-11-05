"use client";

import type { ReactNode } from "react";
import { Select, type SelectProps } from "antd";

// Lets a caller reuse a settings popover from a smaller trigger that needs its own icon, summary and extra controls.
export type CanvasSettingsTriggerProps = {
    buttonIcon?: ReactNode;
    panelHeader?: ReactNode;
    defaultOpen?: boolean;
    formatSummary?: (summary: string) => string;
};

export function shortSettingsSummary(summary: string) {
    const parts = summary.split(" · ");
    return parts.length > 2 ? `${parts[0]} · ${parts[parts.length - 1]}` : summary;
}

// Menus belong to the panel's non-scrolling outer shell, so outside-click
// detection includes them and the scrolling content cannot clip them.
export function canvasSettingsPopupContainer(trigger: HTMLElement): HTMLElement {
    return trigger.closest<HTMLElement>("[data-canvas-settings-popup-root]") || trigger.ownerDocument.body;
}

export function CanvasSettingsSelect(props: SelectProps<string>) {
    return (
        <div className="contents" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()}>
            <Select<string>
                {...props}
                className={props.className || "w-full"}
                getPopupContainer={canvasSettingsPopupContainer}
                popupMatchSelectWidth
                onMouseDown={(event) => event.stopPropagation()}
                popupRender={(menu) => (
                    <div
                        data-canvas-no-zoom
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                        onWheel={(event) => event.stopPropagation()}
                    >
                        {menu}
                    </div>
                )}
            />
        </div>
    );
}

export function canvasSettingsPanelPosition(rect: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width">, viewport: { width: number; height: number }, placement = "topLeft") {
    const margin = 12;
    const gap = 8;
    const width = Math.min(356, Math.max(0, viewport.width - margin * 2));
    const anchorTop = Math.max(margin, Math.min(viewport.height - margin, rect.top));
    const anchorBottom = Math.max(margin, Math.min(viewport.height - margin, rect.bottom));
    const above = Math.max(0, anchorTop - gap - margin);
    const below = Math.max(0, viewport.height - anchorBottom - gap - margin);
    const preferTop = placement.startsWith("top");
    const useTop = preferTop ? above >= 260 || above >= below : below < 260 && above > below;
    const left = placement.endsWith("Right") ? rect.right - width : placement === "top" || placement === "bottom" ? rect.left + rect.width / 2 - width / 2 : rect.left;
    return {
        width,
        left: Math.max(margin, Math.min(viewport.width - width - margin, left)),
        ...(useTop ? { bottom: viewport.height - anchorTop + gap, maxHeight: above } : { top: anchorBottom + gap, maxHeight: below }),
    };
}
