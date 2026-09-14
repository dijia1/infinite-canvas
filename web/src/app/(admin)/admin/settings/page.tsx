"use client";

import { DeleteOutlined, EditOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
import { App, Button, Card, Drawer, Empty, Form, Input, Select, Space, Switch, Table, Tabs, Tag } from "antd";
import { nanoid } from "nanoid";
import { useEffect, useState } from "react";

import { fetchAIProviderTypes, fetchAdminSettings, saveAdminSettings, type AdminAIProvider, type AdminAIProviderType, type AdminSettings } from "@/services/api/admin";
import { isCNYAmountInput } from "@/lib/money";
import { formatImagePrices, isImageResolutionInput } from "@/lib/image-pricing";
import { useAdminStore } from "@/stores/use-admin-store";

const emptySettings: AdminSettings = { revision: 0, ai: { providers: [], imageProviderId: "", videoProviderId: "" } };

type ProviderFormValues = Omit<AdminAIProvider, "config"> & { config: string; fields?: Record<string, string> };

export default function AdminSettingsPage() {
    const token = useAdminStore((state) => state.token);
    const { message } = App.useApp();
    const [settings, setSettings] = useState<AdminSettings>(emptySettings);
    const [types, setTypes] = useState<AdminAIProviderType[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [activeTab, setActiveTab] = useState<"image" | "video">("image");
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
    const scopedTypes = types.filter((item) => (activeTab === "video" ? item.capabilities.includes("video_generate") : supportsImagePricing(types, item.id)));
    const scopedProviders = providers.filter((item) => scopedTypes.some((type) => type.id === item.type));
    const selectOptions = providers.filter((item) => item.enabled).map((item) => ({ value: item.id, label: item.name }));
    const openEditor = (provider?: AdminAIProvider) => {
        setEditingId(provider?.id || null);
        form.resetFields();
        form.setFieldsValue(
            provider
                ? {
                      ...provider,
                      imagePrices: provider.imagePrices || [],
                      videoPrices: provider.videoPrices || [],
                      aspectRatios: provider.aspectRatios || [],
                      config: JSON.stringify(provider.config, null, 2),
                      fields: Object.fromEntries(Object.entries(provider.config).map(([key, value]) => [key, String(value ?? "")])),
                  }
                : { id: nanoid(), name: "", type: scopedTypes[0]?.id || "", enabled: true, imagePrices: [], videoPrices: [], aspectRatios: [], config: "{}", fields: {} },
        );
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
        const imagePrices = (values.imagePrices || []).map((item) => ({ resolution: item.resolution.trim(), amount: item.amount.trim() }));
        const resolutionKeys = new Set<string>();
        for (const item of imagePrices) {
            const key = item.resolution.toLocaleLowerCase();
            if (!isImageResolutionInput(item.resolution) || resolutionKeys.has(key)) {
                message.error("请填写不重复且不含控制字符的上游尺寸参数（最多 64 个字符）");
                return;
            }
            resolutionKeys.add(key);
        }
        const provider: AdminAIProvider = {
            ...values,
            name: values.name.trim(),
            imagePrices,
            videoPrices: (values.videoPrices || []).map((item) => ({ resolution: item.resolution.trim(), amount: item.amount.trim() })),
            aspectRatios: supportsAspectRatios(values.type) ? [...new Set((values.aspectRatios || []).map((value) => value.trim()))] : [],
            config,
        };
        setSettings((current) => ({ ...current, ai: { ...current.ai, providers: editingId ? current.ai.providers.map((item) => (item.id === editingId ? provider : item)) : [...current.ai.providers, provider] } }));
        setDrawerOpen(false);
    };
    const removeProvider = (id: string) => {
        setSettings((current) => ({
            ...current,
            ai: {
                ...current.ai,
                providers: current.ai.providers.filter((item) => item.id !== id),
                imageProviderId: current.ai.imageProviderId === id ? "" : current.ai.imageProviderId,
                videoProviderId: current.ai.videoProviderId === id ? "" : current.ai.videoProviderId,
            },
        }));
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
            <Card
                title="AI 供应商"
                loading={loading}
                extra={
                    <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>
                        保存配置
                    </Button>
                }
            >
                <Tabs
                    activeKey={activeTab}
                    onChange={(key) => setActiveTab(key as "image" | "video")}
                    items={[
                        { key: "image", label: "图片供应商" },
                        { key: "video", label: "视频供应商" },
                    ]}
                />
                <div className="mb-5 max-w-md">
                    <ProviderSelect
                        label={activeTab === "image" ? "默认图片模型" : "默认视频模型"}
                        value={activeTab === "image" ? settings.ai.imageProviderId : settings.ai.videoProviderId}
                        options={selectOptions.filter((item) => supports(types, providers, item.value, activeTab === "image" ? "image_generate" : "video_generate"))}
                        onChange={(id) => setSettings((current) => ({ ...current, ai: { ...current.ai, [activeTab === "image" ? "imageProviderId" : "videoProviderId"]: id } }))}
                    />
                </div>
                {scopedTypes.length === 0 ? (
                    <Empty description="暂无已注册供应商。请先在后端 ai/providers 中实现并注册供应商类型。" />
                ) : (
                    <Table
                        rowKey="id"
                        pagination={false}
                        dataSource={scopedProviders}
                        columns={[
                            { title: "名称", dataIndex: "name" },
                            { title: "类型", dataIndex: "type", render: (value) => types.find((item) => item.id === value)?.name || value },
                            { title: "能力", dataIndex: "type", render: (value) => (types.find((item) => item.id === value)?.capabilities || []).map((item) => <Tag key={item}>{capabilityName(item)}</Tag>) },
                            { title: activeTab === "image" ? "图片价格（元/张）" : "视频价格（元/秒）", render: (_, provider) => formatImagePrices(activeTab === "image" ? provider.imagePrices || [] : provider.videoPrices || []) },
                            { title: "比例", render: (_, provider) => (supportsAspectRatios(provider.type) ? (provider.aspectRatios || []).join("、") || "待配置" : "通过提示词控制") },
                            {
                                title: "状态",
                                render: (_, provider) => (
                                    <Tag color={!provider.enabled ? "default" : supports(types, providers, provider.id, activeTab === "image" ? "image_generate" : "video_generate") ? "green" : "orange"}>
                                        {!provider.enabled ? "停用" : supports(types, providers, provider.id, activeTab === "image" ? "image_generate" : "video_generate") ? "启用" : "待配置"}
                                    </Tag>
                                ),
                            },
                            {
                                title: "操作",
                                render: (_, provider) => (
                                    <Space>
                                        <Button type="link" icon={<EditOutlined />} onClick={() => openEditor(provider)}>
                                            编辑
                                        </Button>
                                        <Button danger type="link" icon={<DeleteOutlined />} onClick={() => removeProvider(provider.id)}>
                                            删除
                                        </Button>
                                    </Space>
                                ),
                            },
                        ]}
                    />
                )}
                {scopedTypes.length > 0 ? (
                    <Button className="mt-4" icon={<PlusOutlined />} onClick={() => openEditor()}>
                        {activeTab === "image" ? "添加图片供应商" : "添加视频供应商"}
                    </Button>
                ) : null}
            </Card>
            <Drawer
                title={editingId ? "编辑供应商" : "添加供应商"}
                width={520}
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                extra={
                    <Button type="primary" onClick={() => void saveProvider()}>
                        确认
                    </Button>
                }
            >
                <Form form={form} layout="vertical">
                    <Form.Item name="id" hidden>
                        <Input />
                    </Form.Item>
                    <Form.Item label="供应商名称" name="name" rules={[{ required: true, message: "请输入供应商名称" }]}>
                        <Input placeholder="例如：豆包生产环境" />
                    </Form.Item>
                    <Form.Item label="供应商类型" name="type" rules={[{ required: true, message: "请选择供应商类型" }]}>
                        <Select options={scopedTypes.map((item) => ({ value: item.id, label: item.name }))} onChange={() => form.setFieldsValue({ imagePrices: [], videoPrices: [], aspectRatios: [], fields: {}, config: "{}" })} />
                    </Form.Item>
                    <Form.Item label="启用" name="enabled" valuePropName="checked">
                        <Switch />
                    </Form.Item>
                    {supportsImagePricing(types, selectedType) ? (
                        <Form.List name="imagePrices">
                            {(fields, { add, remove }) => (
                                <Form.Item label="图片分辨率与单价（元/张）" required extra="已添加的分辨率会在画布中开放；删除即停用该分辨率。">
                                    <Space direction="vertical" className="w-full" size="middle">
                                        {fields.map((field) => (
                                            <Space key={field.key} className="flex w-full" align="baseline">
                                                <Form.Item
                                                    name={[field.name, "resolution"]}
                                                    rules={[
                                                        { required: true, message: "请输入上游尺寸参数" },
                                                        { validator: (_, value: string) => (isImageResolutionInput(value || "") ? Promise.resolve() : Promise.reject(new Error("请输入不含控制字符的上游尺寸参数，最多 64 个字符"))) },
                                                    ]}
                                                    className="mb-0 flex-1"
                                                >
                                                    <Input placeholder="例如：2K 或 2048x1152" />
                                                </Form.Item>
                                                <Form.Item
                                                    name={[field.name, "amount"]}
                                                    rules={[
                                                        { required: true, message: "请输入单价" },
                                                        { validator: (_, value: string) => (isCNYAmountInput(value || "") ? Promise.resolve() : Promise.reject(new Error("请输入 0 至 99999999.9999，最多四位小数"))) },
                                                    ]}
                                                    className="mb-0 flex-1"
                                                >
                                                    <Input inputMode="decimal" placeholder="例如：0.1234" />
                                                </Form.Item>
                                                <Button danger type="text" icon={<DeleteOutlined />} onClick={() => remove(field.name)} aria-label="停用该分辨率" />
                                            </Space>
                                        ))}
                                        <Button type="dashed" onClick={() => add({ resolution: "", amount: "" })}>
                                            添加分辨率
                                        </Button>
                                    </Space>
                                </Form.Item>
                            )}
                        </Form.List>
                    ) : null}
                    {types.find((item) => item.id === selectedType)?.capabilities.includes("video_generate") ? (
                        <Form.List name="videoPrices">
                            {(fields, { add, remove }) => (
                                <Form.Item label="视频分辨率与单价（元/秒）" required extra="已添加的分辨率会在画布中开放；删除即停用该分辨率。">
                                    <Space direction="vertical" className="w-full" size="middle">
                                        {fields.map((field) => (
                                            <Space key={field.key} className="flex w-full" align="baseline">
                                                <Form.Item
                                                    name={[field.name, "resolution"]}
                                                    rules={[
                                                        { required: true, message: "请输入上游尺寸参数" },
                                                        { validator: (_, value: string) => (isImageResolutionInput(value || "") ? Promise.resolve() : Promise.reject(new Error("请输入不含控制字符的上游尺寸参数，最多 64 个字符"))) },
                                                    ]}
                                                    className="mb-0 flex-1"
                                                >
                                                    <Input placeholder="例如：720p" />
                                                </Form.Item>
                                                <Form.Item
                                                    name={[field.name, "amount"]}
                                                    rules={[
                                                        { required: true, message: "请输入单价" },
                                                        { validator: (_, value: string) => (isCNYAmountInput(value || "") ? Promise.resolve() : Promise.reject(new Error("请输入 0 至 99999999.9999，最多四位小数"))) },
                                                    ]}
                                                    className="mb-0 flex-1"
                                                >
                                                    <Input inputMode="decimal" placeholder="例如：0.1234" />
                                                </Form.Item>
                                                <Button danger type="text" icon={<DeleteOutlined />} onClick={() => remove(field.name)} aria-label="停用该分辨率" />
                                            </Space>
                                        ))}
                                        <Button type="dashed" onClick={() => add({ resolution: "", amount: "" })}>
                                            添加分辨率
                                        </Button>
                                    </Space>
                                </Form.Item>
                            )}
                        </Form.List>
                    ) : null}
                    {supportsAspectRatios(selectedType) ? (
                        <Form.List name="aspectRatios">
                            {(fields, { add, remove }) => (
                                <Form.Item label="画布比例选项" extra="按上游支持的比例逐行配置。留空可保存，但模型会标记为待配置。">
                                    <Space direction="vertical" className="w-full">
                                        {fields.map((field) => (
                                            <Space key={field.key} className="flex w-full" align="baseline">
                                                <Form.Item
                                                    name={field.name}
                                                    className="mb-0 flex-1"
                                                    rules={[
                                                        { required: true, message: "请输入比例" },
                                                        { validator: (_, value: string) => (/^(?:auto|[1-9][0-9]{0,3}:[1-9][0-9]{0,3})$/.test((value || "").trim()) ? Promise.resolve() : Promise.reject(new Error("请输入 auto 或 1 至 9999 的整数比例，例如 16:9"))) },
                                                    ]}
                                                >
                                                    <Input placeholder="例如：16:9" />
                                                </Form.Item>
                                                <Button danger type="text" icon={<DeleteOutlined />} onClick={() => remove(field.name)} aria-label="删除该比例" />
                                            </Space>
                                        ))}
                                        <Button type="dashed" onClick={() => add("")}>
                                            添加比例
                                        </Button>
                                    </Space>
                                </Form.Item>
                            )}
                        </Form.List>
                    ) : (
                        <p className="mb-6 text-sm text-gray-500">此模型不支持比例参数，请在提示词中描述画面比例。</p>
                    )}
                    {configFields.length > 0 ? (
                        configFields.map((field) => (
                            <Form.Item key={field.key} label={field.label} name={["fields", field.key]} rules={field.required ? [{ required: true, message: `请输入${field.label}` }] : undefined}>
                                {field.type === "password" ? <Input.Password placeholder={field.placeholder} autoComplete="off" /> : <Input placeholder={field.placeholder} autoComplete="off" />}
                            </Form.Item>
                        ))
                    ) : (
                        <Form.Item label="供应商参数（JSON）" name="config" rules={[{ required: true, message: "请输入供应商参数" }]}>
                            <Input.TextArea rows={12} spellCheck={false} placeholder={'{\n  "apiKey": "..."\n}'} />
                        </Form.Item>
                    )}
                </Form>
            </Drawer>
        </div>
    );
}

function ProviderSelect({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
    return (
        <label className="space-y-2 text-sm">
            <span>{label}</span>
            <Select allowClear className="w-full" value={value || undefined} options={options} placeholder="未配置" onChange={(next) => onChange(next || "")} />
        </label>
    );
}

function supports(types: AdminAIProviderType[], providers: AdminAIProvider[], providerId: string, capability: AdminAIProviderType["capabilities"][number]) {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider || !types.find((item) => item.id === provider.type)?.capabilities.includes(capability)) return false;
    if (capability === "video_generate") return (provider.videoPrices || []).length > 0 && (provider.aspectRatios || []).length > 0;
    return (provider.imagePrices || []).length > 0 && (!supportsAspectRatios(provider.type) || (provider.aspectRatios || []).length > 0);
}

function supportsImagePricing(types: AdminAIProviderType[], type: string) {
    const capabilities = types.find((item) => item.id === type)?.capabilities || [];
    return capabilities.includes("image_generate") || capabilities.includes("image_edit");
}

function capabilityName(value: AdminAIProviderType["capabilities"][number]) {
    return ({ image_generate: "文生图", image_edit: "图像编辑", video_generate: "生视频" } as Record<string, string>)[value];
}

function supportsAspectRatios(type: string) {
    return type !== "doubao-seedream-5-pro";
}
