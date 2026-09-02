"use client";

import { Button, Tag } from "antd";
import { Check, CloudOff, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { useCanvasStore, type CanvasBootstrapStatus, type CanvasProjectSync } from "../stores/use-canvas-store";

export type CanvasSyncDescription = {
    label: string;
    kind: "saved" | "saving" | "offline" | "error" | "conflict";
    refreshable: boolean;
};

export function describeCanvasSync(sync: CanvasProjectSync): CanvasSyncDescription {
    if (sync.conflict) return { label: "版本冲突", kind: "conflict", refreshable: true };
    if (sync.error) return { label: "保存失败", kind: "error", refreshable: false };
    if (sync.offline && (sync.dirty || sync.pending)) return { label: "离线待同步", kind: "offline", refreshable: false };
    if (sync.saving || sync.dirty || sync.pending) return { label: "保存中", kind: "saving", refreshable: false };
    return { label: "已保存", kind: "saved", refreshable: false };
}

export type CanvasBootstrapDescription = {
    label: string;
    kind: "offline" | "error";
    detail: string;
};

export function describeCanvasBootstrap(status: CanvasBootstrapStatus, scope: string | null, error: string | null): CanvasBootstrapDescription | null {
    if (!scope || scope === "guest") return null;
    if (status === "error") return { label: "同步连接失败", kind: "error", detail: error || "暂时无法连接画布服务" };
    if (status === "offline") return { label: "离线使用", kind: "offline", detail: error || "恢复网络后可重试同步" };
    return null;
}

const syncAppearance = {
    saved: { color: "success", icon: <Check className="size-3" /> },
    saving: { color: "processing", icon: <LoaderCircle className="size-3 animate-spin" /> },
    offline: { color: "default", icon: <CloudOff className="size-3" /> },
    error: { color: "error", icon: <TriangleAlert className="size-3" /> },
    conflict: { color: "warning", icon: <TriangleAlert className="size-3" /> },
} as const;

export function CanvasBootstrapFeedback() {
    const status = useCanvasStore((state) => state.bootstrapStatus);
    const scope = useCanvasStore((state) => state.syncScope);
    const error = useCanvasStore((state) => state.bootstrapError);
    const retryBootstrap = useCanvasStore((state) => state.retryBootstrap);
    const canRetry = useCanvasStore((state) => Boolean(state.bootstrapRetry));
    const [retrying, setRetrying] = useState(false);
    const description = describeCanvasBootstrap(status, scope, error);

    if (!description) return null;
    const appearance = syncAppearance[description.kind];
    const retry = async () => {
        setRetrying(true);
        try {
            await retryBootstrap();
        } finally {
            setRetrying(false);
        }
    };

    return (
        <span className="inline-flex min-w-0 items-center gap-1" title={description.detail}>
            <Tag bordered={false} color={appearance.color} icon={appearance.icon} className="m-0 inline-flex items-center text-xs">
                {description.label}
            </Tag>
            {canRetry ? (
                <Button type="link" size="small" loading={retrying} icon={<RefreshCw className="size-3" />} className="h-6 px-1 text-xs" onClick={() => void retry()}>
                    重试
                </Button>
            ) : null}
        </span>
    );
}

export function CanvasSyncFeedback({ projectId }: { projectId: string }) {
    const syncEnabled = useCanvasStore((state) => state.syncEnabled);
    const sync = useCanvasStore((state) => state.projectSync[projectId]);
    const refreshProjectFromServer = useCanvasStore((state) => state.refreshProjectFromServer);
    const [refreshing, setRefreshing] = useState(false);

    if (!syncEnabled || !sync) return null;
    const description = describeCanvasSync(sync);
    const appearance = syncAppearance[description.kind];

    const refresh = async () => {
        setRefreshing(true);
        try {
            await refreshProjectFromServer(projectId);
        } catch {
            // The store keeps the project and exposes the refresh error through sync metadata.
        } finally {
            setRefreshing(false);
        }
    };

    return (
        <span className="inline-flex min-w-0 items-center gap-1" onClick={(event) => event.stopPropagation()}>
            <Tag bordered={false} color={appearance.color} icon={appearance.icon} className="m-0 inline-flex items-center text-xs">
                {description.label}
            </Tag>
            {description.refreshable ? (
                <Button type="link" size="small" loading={refreshing} icon={<RefreshCw className="size-3" />} className="h-6 px-1 text-xs" onClick={() => void refresh()}>
                    加载服务器版本
                </Button>
            ) : null}
        </span>
    );
}
