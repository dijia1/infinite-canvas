"use client";

import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { App, Button, Form, Input } from "antd";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { useAdminStore } from "@/stores/use-admin-store";

type LoginFormValues = {
    username: string;
    password: string;
};

export default function AdminLoginPage() {
    return (
        <Suspense fallback={null}>
            <AdminLoginContent />
        </Suspense>
    );
}

function AdminLoginContent() {
    const { message } = App.useApp();
    const searchParams = useSearchParams();
    const login = useAdminStore((state) => state.login);
    const isLoading = useAdminStore((state) => state.isLoading);

    const submit = async (values: LoginFormValues) => {
        try {
            await login(values);
            message.success("登录成功");
            const redirect = searchParams.get("redirect");
            window.location.replace(redirect?.startsWith("/admin") && !redirect.startsWith("/admin/login") ? redirect : "/admin/settings");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败");
        }
    };

    return (
        <main className="flex min-h-dvh items-center justify-center bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-10 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.16)_1px,transparent_1px)]">
            <section className="w-full max-w-[420px]">
                <div className="mb-7 text-center">
                    <span
                        className="mx-auto mb-4 block size-12 bg-stone-950 dark:bg-stone-100"
                        style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }}
                        aria-label="无限画布"
                    />
                    <h1 className="text-3xl font-semibold tracking-normal text-stone-950 dark:text-stone-100">管理员登录</h1>
                    <p className="mt-3 text-base leading-7 text-stone-500 dark:text-stone-400">登录后管理模型渠道、提示词和素材。</p>
                </div>

                <Form<LoginFormValues> layout="vertical" size="large" requiredMark={false} onFinish={submit}>
                    <Form.Item name="username" label="管理员用户名" rules={[{ required: true, message: "请输入管理员用户名" }]}>
                        <Input prefix={<UserOutlined />} autoComplete="username" />
                    </Form.Item>
                    <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                        <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
                    </Form.Item>
                    <Button block type="primary" htmlType="submit" loading={isLoading}>
                        登录
                    </Button>
                </Form>
            </section>
        </main>
    );
}
