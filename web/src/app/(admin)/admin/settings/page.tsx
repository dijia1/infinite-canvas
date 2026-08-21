"use client";

import { DeleteOutlined, EditOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
import { App, Button, Card, Drawer, Empty, Form, Input, Select, Space, Switch, Table, Tag } from "antd";
import { nanoid } from "nanoid";
import { useEffect, useState } from "react";

import { fetchAIProviderTypes, fetchAdminSettings, saveAdminSettings, type AdminAIProvider, type AdminAIProviderType, type AdminSettings } from "@/services/api/admin";
import { useAdminStore } from "@/stores/use-admin-store";

const emptySettings: AdminSettings = { ai: { providers: [], imageProviderId: "", videoProviderId: "" } };

type ProviderFormValues = Omit<AdminAIProvider, "config"> & { config: string; fields?: Record<string, string> };

export default function AdminSettingsPage() {
    const token = useAdminStore((state) => state.token);
    const { message } = App.useApp();
    const [settings, setSettings] = useState<AdminSettings>(emptySettings);
    const [types, setTypes] = useState<AdminAIProviderType[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [form] = Form.useForm<ProviderFormValues>();
    const selectedType = Form.useWatch("type", form);
    const configFields = types.find((item) => item.id === selectedType)?.configFields || [];

    useEffect(() => {
        if (!token) return;
        void Promise.all([fetchAdminSettings(token), fetchAIProviderTypes(token)])
            .then(([nextSettings, nextTypes]) => {
                setSettings(nextSettings);
                setTypes(nextTypes);
            })
            .catch((error) => message.error(error instanceof Error ? error.message : "读取 AI 配置失败"))
            .finally(() => setLoading(false));
    }, [message, token]);

    const providers = settings.ai.providers;
    const selectOptions = providers.filter((item) => item.enabled).map((item) => ({ value: item.id, label: item.name }));
    const openEditor = (provider?: AdminAIProvider) => {
        setEditingId(provider?.id || null);
        form.setFieldsValue(provider ? { ...provider, config: JSON.stringify(provider.config, null, 2), fields: Object.fromEntries(Object.entries(provider.config).map(([key, value]) => [key, String(value ?? "")])) } : { id: nanoid(), name: "", type: types[0]?.id || "", enabled: true, config: "{}", fields: {} });
        setDrawerOpen(true);
    };
    const saveProvider = async () => {
        const values = await form.validateFields();
        let config: Record<string, unknown> = Object.fromEntries(configFields.map((field) => [field.key, values.fields?.[field.key] || ""]));
        if (configFields.length === 0) {
            try {
                config = JSON.parse(values.config) as Record<string, unknown>;
            } catch {
                message.error("供应商参数必须是有效 JSON");
                return;
            }
        }
        const provider: AdminAIProvider = { ...values, name: values.name.trim(), config };
        setSettings((current) => ({ ...current, ai: { ...current.ai, providers: editingId ? current.ai.providers.map((item) => (item.id === editingId ? provider : item)) : [...current.ai.providers, provider] } }));
        setDrawerOpen(false);
    };
    const removeProvider = (id: string) => {
        setSettings((current) => ({ ...current, ai: { ...current.ai, providers: current.ai.providers.filter((item) => item.id !== id), imageProviderId: current.ai.imageProviderId === id ? "" : current.ai.imageProviderId, videoProviderId: current.ai.videoProviderId === id ? "" : current.ai.videoProviderId } }));
    };
    const save = async () => {
        if (!token) return;
        setSaving(true);
        try {
            setSettings(await saveAdminSettings(token, settings));
            message.success("AI 配置已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-5">
            <Card title="AI 供应商" loading={loading} extra={<Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>保存配置</Button>}>
                <div className="mb-5 grid gap-4 md:grid-cols-2">
                    <ProviderSelect label="生图供应商" value={settings.ai.imageProviderId} options={selectOptions.filter((item) => supports(types, providers, item.value, "image_generate"))} onChange={(imageProviderId) => setSettings((current) => ({ ...current, ai: { ...current.ai, imageProviderId } }))} />
                    <ProviderSelect label="生视频供应商" value={settings.ai.videoProviderId} options={selectOptions.filter((item) => supports(types, providers, item.value, "video_generate"))} onChange={(videoProviderId) => setSettings((current) => ({ ...current, ai: { ...current.ai, videoProviderId } }))} />
                </div>
                {types.length === 0 ? <Empty description="暂无已注册供应商。请先在后端 ai/providers 中实现并注册供应商类型。" /> : <Table rowKey="id" pagination={false} dataSource={providers} columns={[
                    { title: "名称", dataIndex: "name" },
                    { title: "类型", dataIndex: "type", render: (value) => types.find((item) => item.id === value)?.name || value },
                    { title: "能力", dataIndex: "type", render: (value) => (types.find((item) => item.id === value)?.capabilities || []).map((item) => <Tag key={item}>{capabilityName(item)}</Tag>) },
                    { title: "状态", dataIndex: "enabled", render: (enabled) => <Tag color={enabled ? "green" : "default"}>{enabled ? "启用" : "停用"}</Tag> },
                    { title: "操作", render: (_, provider) => <Space><Button type="link" icon={<EditOutlined />} onClick={() => openEditor(provider)}>编辑</Button><Button danger type="link" icon={<DeleteOutlined />} onClick={() => removeProvider(provider.id)}>删除</Button></Space> },
                ]} />}
                {types.length > 0 ? <Button className="mt-4" icon={<PlusOutlined />} onClick={() => openEditor()}>添加供应商</Button> : null}
            </Card>
            <Drawer title={editingId ? "编辑供应商" : "添加供应商"} width={520} open={drawerOpen} onClose={() => setDrawerOpen(false)} extra={<Button type="primary" onClick={() => void saveProvider()}>确认</Button>}>
                <Form form={form} layout="vertical">
                    <Form.Item name="id" hidden><Input /></Form.Item>
                    <Form.Item label="供应商名称" name="name" rules={[{ required: true, message: "请输入供应商名称" }]}><Input placeholder="例如：豆包生产环境" /></Form.Item>
                    <Form.Item label="供应商类型" name="type" rules={[{ required: true, message: "请选择供应商类型" }]}><Select options={types.map((item) => ({ value: item.id, label: item.name }))} /></Form.Item>
                    <Form.Item label="启用" name="enabled" valuePropName="checked"><Switch /></Form.Item>
                    {configFields.length > 0 ? configFields.map((field) => <Form.Item key={field.key} label={field.label} name={["fields", field.key]} rules={field.required ? [{ required: true, message: `请输入${field.label}` }] : undefined}>{field.type === "password" ? <Input.Password placeholder={field.placeholder} autoComplete="off" /> : <Input placeholder={field.placeholder} autoComplete="off" />}</Form.Item>) : <Form.Item label="供应商参数（JSON）" name="config" rules={[{ required: true, message: "请输入供应商参数" }]}><Input.TextArea rows={12} spellCheck={false} placeholder={'{\n  "apiKey": "..."\n}'} /></Form.Item>}
                </Form>
            </Drawer>
        </div>
    );
}

function ProviderSelect({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
    return <label className="space-y-2 text-sm"><span>{label}</span><Select allowClear className="w-full" value={value || undefined} options={options} placeholder="未配置" onChange={(next) => onChange(next || "")} /></label>;
}

function supports(types: AdminAIProviderType[], providers: AdminAIProvider[], providerId: string, capability: AdminAIProviderType["capabilities"][number]) {
    const provider = providers.find((item) => item.id === providerId);
    return Boolean(provider && types.find((item) => item.id === provider.type)?.capabilities.includes(capability));
}

function capabilityName(value: AdminAIProviderType["capabilities"][number]) {
    return ({ image_generate: "文生图", image_edit: "图像编辑", video_generate: "生视频" } as Record<string, string>)[value];
}
