"use client";

import { Images, Library, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

import { AppActions } from "@/components/layout/app-actions";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { MyAssetsDrawer } from "@/app/(user)/canvas/components/asset-picker-modal";
import { PublicImageDrawer } from "@/app/(user)/canvas/components/public-image-drawer";
import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { appPath } from "@/lib/app-path";
import { cn } from "@/lib/utils";
import { toggleMaterialPanel, type MaterialPanel } from "@/components/layout/material-panel";

export function AppTopNav() {
    const pathname = usePathname();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const [materialPanel, setMaterialPanel] = useState<MaterialPanel>(null);
    const hideHeader = /^\/canvas\/[^/]+/.test(pathname);
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeToolSlug = navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;

    return (
        <>
            {!hideHeader ? (
                <header className="sticky top-0 z-20 h-16 shrink-0 border-b border-stone-200 bg-background/90 backdrop-blur-xl dark:border-stone-800">
                    <div className="flex h-full w-full items-stretch justify-between gap-5 px-4 sm:px-6">
                        <div className="flex min-w-0 items-center">
                            <Link href={appPath("/canvas")} className="flex h-full shrink-0 items-center gap-2 text-sm font-semibold leading-none tracking-tight text-stone-950 transition hover:text-stone-600 dark:text-stone-100 dark:hover:text-stone-300">
                                <span className="size-5 shrink-0 bg-current" style={{ mask: `url(${appPath("/logo.svg")}) center / contain no-repeat`, WebkitMask: `url(${appPath("/logo.svg")}) center / contain no-repeat` }} />
                                <span className="text-base font-medium">无限画布</span>
                            </Link>

                            <button type="button" className="ml-3 inline-flex size-8 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 md:hidden dark:text-stone-300 dark:hover:text-white" onClick={() => setMobileNavOpen(true)} aria-label="打开导航菜单" title="导航菜单">
                                <Menu className="size-5" />
                            </button>

                            <nav className="hide-scrollbar ml-8 hidden h-16 min-w-0 items-center gap-7 overflow-x-auto md:flex">
                                {navigationTools.map((tool) => {
                                    const Icon = tool.icon;
                                    const active = tool.slug === activeToolSlug;
                                    return (
                                        <Link
                                            key={tool.slug}
                                            href={appPath(`/${tool.slug}`)}
                                            className={cn(
                                                "relative flex h-16 shrink-0 items-center gap-2 text-sm leading-6 transition after:absolute after:inset-x-0 after:bottom-0 after:h-px",
                                                active ? "font-medium text-stone-950 after:bg-stone-950 dark:text-stone-100 dark:after:bg-stone-100" : "text-stone-500 after:bg-transparent hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100",
                                            )}
                                        >
                                            <Icon className="size-4" />
                                            <span className="truncate">{tool.label}</span>
                                        </Link>
                                    );
                                })}
                                <TopMaterialButton active={materialPanel === "my-assets"} onClick={() => setMaterialPanel((current) => toggleMaterialPanel(current, "my-assets"))}>
                                    <Images className="size-4" />
                                    我的素材
                                </TopMaterialButton>
                                <TopMaterialButton active={materialPanel === "public-assets"} onClick={() => setMaterialPanel((current) => toggleMaterialPanel(current, "public-assets"))}>
                                    <Library className="size-4" />
                                    公共素材
                                </TopMaterialButton>
                            </nav>
                        </div>

                        <div className="my-auto flex h-9 min-w-0 items-center justify-end gap-2 justify-self-end whitespace-nowrap">
                            <AppActions />
                        </div>
                    </div>
                </header>
            ) : null}

            <MobileNavDrawer
                open={mobileNavOpen}
                activeToolSlug={activeToolSlug}
                onClose={() => setMobileNavOpen(false)}
                onOpenMyAssets={() => setMaterialPanel("my-assets")}
                onOpenPublicAssets={() => setMaterialPanel("public-assets")}
            />
            <AppConfigModal />
            <MyAssetsDrawer open={materialPanel === "my-assets"} onClose={() => setMaterialPanel(null)} />
            <PublicImageDrawer open={materialPanel === "public-assets"} onClose={() => setMaterialPanel(null)} />
        </>
    );
}

function TopMaterialButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
    return (
        <button
            type="button"
            className={cn(
                "relative flex h-16 shrink-0 items-center gap-2 text-sm leading-6 transition after:absolute after:inset-x-0 after:bottom-0 after:h-px",
                active ? "font-medium text-stone-950 after:bg-stone-950 dark:text-stone-100 dark:after:bg-stone-100" : "text-stone-500 after:bg-transparent hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100",
            )}
            onClick={onClick}
        >
            {children}
        </button>
    );
}
