"use client";

import { FileTextOutlined, HomeOutlined, LogoutOutlined, PictureOutlined, SettingOutlined, TeamOutlined } from "@ant-design/icons";
import { Button, Flex, Layout, Menu, Typography, theme } from "antd";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect } from "react";

import { adminLayoutStyle } from "@/lib/app-theme";
import { appPath } from "@/lib/app-path";
import { useAdminStore } from "@/stores/use-admin-store";

const adminMenus = [
    { key: "/admin/assets", icon: <PictureOutlined />, label: "素材库" },
    { key: "/admin/members", icon: <TeamOutlined />, label: "成员管理" },
    { key: "/admin/operations", icon: <FileTextOutlined />, label: "操作记录" },
    { key: "/admin/settings", icon: <SettingOutlined />, label: "系统设置" },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
    const { token: antToken } = theme.useToken();
    const router = useRouter();
    const pathname = usePathname();
    const token = useAdminStore((state) => state.token);
    const user = useAdminStore((state) => state.user);
    const isReady = useAdminStore((state) => state.isReady);
    const hydrateAdmin = useAdminStore((state) => state.hydrateAdmin);
    const logout = useAdminStore((state) => state.clearSession);
    const activeKey = pathname.startsWith("/admin/settings") ? "/admin/settings" : pathname.startsWith("/admin/operations") ? "/admin/operations" : pathname.startsWith("/admin/members") ? "/admin/members" : pathname.startsWith("/admin/assets") ? "/admin/assets" : "";
    const pageTitle = pathname.startsWith("/admin/settings") ? "系统设置" : pathname.startsWith("/admin/operations") ? "操作记录" : pathname.startsWith("/admin/members") ? "成员管理" : "素材库管理";

    useEffect(() => {
        void hydrateAdmin();
    }, [hydrateAdmin]);

    useEffect(() => {
        if (!isReady) return;
        if (!token) {
            router.replace(appPath(`/admin/login?redirect=${encodeURIComponent(pathname)}`));
            return;
        }
    }, [isReady, pathname, router, token]);

    if (!isReady || !token || user?.role !== "admin") {
        return (
            <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: antToken.colorBgLayout }}>
                <span />
            </div>
        );
    }

    return (
        <Layout hasSider style={{ height: "100vh", overflow: "hidden", background: antToken.colorBgLayout }}>
            <Layout.Sider width={adminLayoutStyle.siderWidth} style={{ height: "100vh", overflow: "hidden", background: antToken.colorBgContainer, borderRight: `1px solid ${antToken.colorBorder}` }}>
                <Flex align="center" gap={12} style={{ height: adminLayoutStyle.brandHeight, padding: "0 20px", borderBottom: `1px solid ${antToken.colorBorderSecondary}` }}>
                    <span
                        aria-hidden
                        style={{ display: "inline-block", width: 30, height: 30, background: antToken.colorText, WebkitMask: `url(${appPath("/logo.svg")}) center / contain no-repeat`, mask: `url(${appPath("/logo.svg")}) center / contain no-repeat` }}
                    />
                    <Typography.Text strong style={{ fontSize: 18, letterSpacing: 0 }}>
                        无限画布
                    </Typography.Text>
                </Flex>
                <Menu
                    mode="inline"
                    selectedKeys={[activeKey]}
                    style={adminLayoutStyle.menu}
                    items={adminMenus.map((item) => ({
                        ...item,
                        label: (
                            <Link href={appPath(item.key)} style={{ color: "inherit" }}>
                                {item.label}
                            </Link>
                        ),
                        style: adminLayoutStyle.menuItem,
                    }))}
                />
                <Flex vertical gap={8} style={{ position: "absolute", bottom: 0, insetInline: 0, padding: 12, borderTop: `1px solid ${antToken.colorBorder}`, background: antToken.colorBgContainer }}>
                    <Button block icon={<HomeOutlined />} href={appPath("/canvas")} target="_blank" rel="noreferrer">
                        前往画布
                    </Button>
                    <Button block icon={<LogoutOutlined />} onClick={logout}>
                        退出登录
                    </Button>
                </Flex>
            </Layout.Sider>
            <Layout style={{ background: antToken.colorBgLayout }}>
                <Layout.Header
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: adminLayoutStyle.headerHeight, padding: "0 24px", background: antToken.colorBgContainer, borderBottom: `1px solid ${antToken.colorBorder}` }}
                >
                    <Typography.Title level={5} style={{ margin: 0 }}>
                        {pageTitle}
                    </Typography.Title>
                    <Typography.Text type="secondary">{user.username}</Typography.Text>
                </Layout.Header>
                <Layout.Content style={{ minHeight: 0, overflow: "auto" }}>{children}</Layout.Content>
            </Layout>
        </Layout>
    );
}
