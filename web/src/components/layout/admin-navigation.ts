import { BarChart3, ClipboardList, Settings, Users, type LucideIcon } from "lucide-react";

export type AdminNavigationItem = {
    key: string;
    label: string;
    href: string;
    icon: LucideIcon;
};

export const adminNavigationItems: AdminNavigationItem[] = [
    { key: "members", label: "成员管理", href: "/admin/members", icon: Users },
    { key: "operation-logs", label: "操作记录", href: "/admin/operations", icon: ClipboardList },
    { key: "statistics", label: "统计", href: "/admin/statistics", icon: BarChart3 },
    { key: "settings", label: "系统设置", href: "/admin/settings", icon: Settings },
];
