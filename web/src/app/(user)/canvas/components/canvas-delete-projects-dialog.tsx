"use client";

import { App, Button, Modal } from "antd";

import { useState } from "react";

import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "../stores/use-canvas-store";
import { useCanvasUiStore } from "../stores/use-canvas-ui-store";

export function CanvasDeleteProjectsDialog() {
    const { message } = App.useApp();
    const [deleting, setDeleting] = useState(false);
    const withProjectMutation = useCanvasStore((state) => state.withProjectMutation);
    const ids = useCanvasUiStore((state) => state.deleteProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const confirm = async () => {
        if (deleting) return;
        setDeleting(true);
        try {
            await withProjectMutation(ids, async () => {
                deleteProjects(ids);
            });
            cleanupImages();
            setDeleteIds([]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除画布失败");
        } finally {
            setDeleting(false);
        }
    };

    return (
        <Modal
            title="删除画布？"
            open={ids.length > 0}
            centered
            onCancel={() => setDeleteIds([])}
            footer={
                <>
                    <Button onClick={() => setDeleteIds([])}>取消</Button>
                    <Button danger type="primary" loading={deleting} onClick={() => void confirm()}>
                        删除
                    </Button>
                </>
            }
        >
            <p className="text-sm text-stone-500">将删除 {ids.length} 个画布，里面的节点和连线也会一起移除。</p>
        </Modal>
    );
}
