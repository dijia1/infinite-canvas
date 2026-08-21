"use client";

import { Button, Modal } from "antd";

import { useConfigStore } from "@/stores/use-config-store";

export function AppConfigModal() {
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);

    return <Modal title="AI 服务未配置" open={isConfigOpen} centered onCancel={() => setConfigDialogOpen(false)} footer={<Button type="primary" onClick={() => { setConfigDialogOpen(false); clearPromptContinue(); }}>知道了</Button>}>
        <p className="text-sm text-stone-600 dark:text-stone-300">请由管理员在“系统设置 → AI 供应商”中添加供应商实例，并分别选择生图和生视频供应商。</p>
    </Modal>;
}
