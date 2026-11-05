"use client";

import type { CSSProperties } from "react";
import { Dropdown } from "antd";
import { useEditorNavigation } from "./editor-navigation";
import { Clock3, Keyboard, Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { canvasThemes } from "@/lib/canvas-theme";
import { appPath } from "@/lib/app-path";
import { useThemeStore } from "@/stores/use-theme-store";

type AppActionsProps = {
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenSettings?: () => void;
};

export function AppActions({ variant = "default", onOpenShortcuts, onOpenSettings }: AppActionsProps) {
    const theme = useThemeStore((state) => state.theme);
    const router = useRouter();
    const editorNavigation = useEditorNavigation();
    const navigate = (href: string) => void (editorNavigation ? editorNavigation.navigate(href) : router.push(href));
    const canvasTheme = canvasThemes[theme];
    const className = "inline-flex size-8 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white [&_svg]:size-4";
    const style: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;

    return (
        <div className="inline-flex shrink-0 items-center gap-1.5">
            <Dropdown trigger={["click"]} menu={{ items: [
                { key: "runs", label: "运行记录", icon: <Clock3 className="size-4" />, onClick: () => navigate(appPath("/workflow-runs")) },
                { key: "settings", label: "系统设置", icon: <Settings2 className="size-4" />, onClick: () => onOpenSettings ? onOpenSettings() : navigate(appPath("/admin/settings")) },
            ] }}>
                <button type="button" className={className} style={style} aria-label="配置" title="配置">
                    <Settings2 className="size-4" />
                </button>
            </Dropdown>
            {onOpenShortcuts ? (
                <button type="button" className={className} style={style} onClick={onOpenShortcuts} aria-label="快捷键" title="快捷键">
                    <Keyboard className="size-4" />
                </button>
            ) : null}
        </div>
    );
}
