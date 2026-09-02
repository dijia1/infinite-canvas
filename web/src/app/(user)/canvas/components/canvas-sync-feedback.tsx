"use client";

import { Button, Tag } from "antd";
import { Check, CloudOff, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { useCanvasStore, type CanvasProjectSync } from "../stores/use-canvas-store";

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

export async function refreshCanvasServerVersion<Project>(
    projectId: string,
    dependencies: {
        refreshProjectFromServer: (id: string) => Promise<void>;
        readProject: (id: string) => Project | null;
        restoreProject: (project: Project) => Promise<void>;
    },
) {
    await dependencies.refreshProjectFromServer(projectId);
    const project = dependencies.readProject(projectId);
    if (!project) return false;
    await dependencies.restoreProject(project);
    return true;
}

const syncAppearance = {
    saved: { color: "success", icon: <Check className="size-3" /> },
    saving: { color: "processing", icon: <LoaderCircle className="size-3 animate-spin" /> },
    offline: { color: "default", icon: <CloudOff className="size-3" /> },
    error: { color: "error", icon: <TriangleAlert className="size-3" /> },
    conflict: { color: "warning", icon: <TriangleAlert className="size-3" /> },
} as const;

export function CanvasSyncFeedback({ projectId, onRefreshServerVersion }: { projectId: string; onRefreshServerVersion?: () => Promise<void> }) {
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
            await (onRefreshServerVersion ? onRefreshServerVersion() : refreshProjectFromServer(projectId));
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
