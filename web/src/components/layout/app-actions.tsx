"use client";

import type { CSSProperties } from "react";
import { Keyboard, Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { canvasThemes } from "@/lib/canvas-theme";
import { appPath } from "@/lib/app-path";
import { useThemeStore } from "@/stores/use-theme-store";

type AppActionsProps = {
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
};

export function AppActions({ variant = "default", onOpenShortcuts }: AppActionsProps) {
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const router = useRouter();
    const canvasTheme = canvasThemes[theme];
    const className = "inline-flex size-8 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white [&_svg]:size-4";
    const style: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;

    return (
        <div className="inline-flex shrink-0 items-center gap-1.5">
            <button type="button" className={className} style={style} onClick={() => router.push(appPath("/admin/settings"))} aria-label="配置" title="配置">
                <Settings2 className="size-4" />
            </button>
            <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={className} style={style} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} />
            {onOpenShortcuts ? (
                <button type="button" className={className} style={style} onClick={onOpenShortcuts} aria-label="快捷键" title="快捷键">
                    <Keyboard className="size-4" />
                </button>
            ) : null}
        </div>
    );
}
