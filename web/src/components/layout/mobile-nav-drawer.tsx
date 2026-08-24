"use client";

import { Drawer } from "antd";
import { ClipboardList, Images, Library, Users } from "lucide-react";
import Link from "next/link";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { appPath } from "@/lib/app-path";
import { cn } from "@/lib/utils";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
    onOpenMyAssets: () => void;
    onOpenPublicAssets: () => void;
    isAdmin: boolean;
};

export function MobileNavDrawer({ open, activeToolSlug, onClose, onOpenMyAssets, onOpenPublicAssets, isAdmin }: MobileNavDrawerProps) {
    return (
        <Drawer title="导航" placement="left" size={280} open={open} onClose={onClose} className="md:hidden">
            <div className="space-y-1">
                {navigationTools.map((tool) => {
                    const Icon = tool.icon;
                    const active = tool.slug === activeToolSlug;
                    return (
                        <Link
                            key={tool.slug}
                            href={appPath(`/${tool.slug}`)}
                            onClick={onClose}
                            className={cn(
                                "flex items-center gap-3 rounded-lg px-3 py-3 text-base transition",
                                active ? "bg-stone-100 font-medium text-stone-950 dark:bg-stone-800 dark:text-stone-100" : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100",
                            )}
                        >
                            <Icon className="size-5" />
                            <span>{tool.label}</span>
                        </Link>
                    );
                })}
                <button
                    type="button"
                    onClick={() => {
                        onClose();
                        onOpenMyAssets();
                    }}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-base text-stone-600 transition hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100"
                >
                    <Images className="size-5" />
                    <span>我的素材</span>
                </button>
                <button
                    type="button"
                    onClick={() => {
                        onClose();
                        onOpenPublicAssets();
                    }}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-base text-stone-600 transition hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100"
                >
                    <Library className="size-5" />
                    <span>公共素材</span>
                </button>
                {isAdmin ? (
                    <>
                        <Link
                            href={appPath("/admin/members")}
                            onClick={onClose}
                            className="flex items-center gap-3 rounded-lg px-3 py-3 text-base text-stone-600 transition hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100"
                        >
                            <Users className="size-5" />
                            <span>成员管理</span>
                        </Link>
                        <Link
                            href={appPath("/admin/operations")}
                            onClick={onClose}
                            className="flex items-center gap-3 rounded-lg px-3 py-3 text-base text-stone-600 transition hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100"
                        >
                            <ClipboardList className="size-5" />
                            <span>操作记录</span>
                        </Link>
                    </>
                ) : null}
            </div>
        </Drawer>
    );
}
