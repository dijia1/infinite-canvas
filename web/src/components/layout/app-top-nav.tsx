"use client";

import { Dropdown } from "antd";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Images, Library, Menu } from "lucide-react";
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
import { fetchPortalSession } from "@/services/api/session";

export function AppTopNav() {
    const pathname = usePathname();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const [materialPanel, setMaterialPanel] = useState<MaterialPanel>(null);
    const hideHeader = /^\/canvas\/[^/]+/.test(pathname);
    const session = useQuery({ queryKey: ["portal-session"], queryFn: fetchPortalSession, enabled: !hideHeader, retry: false, staleTime: 5 * 60 * 1000 });
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeToolSlug = navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;

    return (
        <>
            {!hideHeader ? (
                <header className="sticky top-0 z-20 h-16 shrink-0 border-b border-stone-200 bg-background/90 backdrop-blur-xl dark:border-stone-800">
                    <div className="flex h-full w-full items-stretch justify-between gap-5 px-4 sm:px-6">
                        <div className="flex min-w-0 items-center">
                            <Link
                                href="/"
                                className="inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-stone-300 px-3 text-sm font-medium text-stone-700 transition hover:border-stone-400 hover:bg-stone-100 hover:text-stone-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 dark:border-stone-700 dark:text-stone-200 dark:hover:border-stone-600 dark:hover:bg-stone-800 dark:hover:text-white"
                            >
                                返回工作台
                            </Link>

                            <button
                                type="button"
                                className="ml-3 inline-flex size-8 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 md:hidden dark:text-stone-300 dark:hover:text-white"
                                onClick={() => setMobileNavOpen(true)}
                                aria-label="打开导航菜单"
                                title="导航菜单"
                            >
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
                                                active
                                                    ? "font-medium text-stone-950 after:bg-stone-950 dark:text-stone-100 dark:after:bg-stone-100"
                                                    : "text-stone-500 after:bg-transparent hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100",
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
                                {session.data?.isAdmin ? (
                                    <Dropdown menu={{ items: [{ key: "members", label: <Link href={appPath("/admin/members")}>成员管理</Link> }, { key: "operation-logs", label: <Link href={appPath("/admin/operations")}>操作记录</Link> }] }} trigger={["click"]}>
                                        <button type="button" className="relative flex h-16 shrink-0 items-center gap-1 text-sm leading-6 text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100">
                                            管理
                                            <ChevronDown className="size-3.5" />
                                        </button>
                                    </Dropdown>
                                ) : null}
                            </nav>
                        </div>

                        <div className="my-auto flex h-9 min-w-0 items-center justify-end gap-2 justify-self-end whitespace-nowrap">
                            {session.data?.user.displayName ? (
                                <span className="max-w-32 truncate text-sm text-stone-600 dark:text-stone-300" title={session.data.user.displayName}>
                                    {session.data.user.displayName}
                                </span>
                            ) : null}
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
                isAdmin={Boolean(session.data?.isAdmin)}
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
