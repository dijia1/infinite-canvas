"use client";

import { App, Button, Form, Modal } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";

export function AppConfigModal() {
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const modelChannel = useConfigStore((state) => state.publicSettings?.modelChannel);
    const effectiveConfig = useEffectiveConfig();

    const finishConfig = () => {
        if (!effectiveConfig.imageModel.trim() || !effectiveConfig.videoModel.trim() || !effectiveConfig.textModel.trim()) {
            message.error("请先由管理员配置可用模型");
            return;
        }
        setConfigDialogOpen(false);
        message.success(shouldPromptContinue ? "配置已保存，请继续刚才的请求" : "配置已保存");
        clearPromptContinue();
    };

    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">模型配置</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">从管理员发布的云端模型中选择默认项</div>
                </div>
            }
            open={isConfigOpen}
            width={720}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            footer={
                <Button type="primary" onClick={finishConfig}>
                    完成
                </Button>
            }
        >
            <div className="pt-1">
                <div className="mb-4 rounded-lg border border-stone-200 p-3 text-sm text-stone-500 dark:border-stone-800">
                    <div className="font-medium text-stone-900 dark:text-stone-100">云端渠道</div>
                    <div className="mt-1">渠道与密钥由管理员统一维护，当前发布 {modelChannel?.availableModels.length || 0} 个模型。</div>
                </div>
                <Form layout="vertical" requiredMark={false}>
                    <div className="grid gap-4 md:grid-cols-3">
                        <Form.Item label="默认生图模型" className="mb-0">
                            <ModelPicker config={effectiveConfig} value={effectiveConfig.imageModel} onChange={(model) => updateConfig("imageModel", model)} fullWidth />
                        </Form.Item>
                        <Form.Item label="默认视频模型" className="mb-0">
                            <ModelPicker config={effectiveConfig} value={effectiveConfig.videoModel} onChange={(model) => updateConfig("videoModel", model)} fullWidth />
                        </Form.Item>
                        <Form.Item label="默认文本模型" className="mb-0">
                            <ModelPicker config={effectiveConfig} value={effectiveConfig.textModel} onChange={(model) => updateConfig("textModel", model)} fullWidth />
                        </Form.Item>
                    </div>
                </Form>
            </div>
        </Modal>
    );
}
