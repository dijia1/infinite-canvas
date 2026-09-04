"use client";

import { type ReactNode } from "react";
import { Tooltip } from "antd";
import { Brush, Camera, Download, FolderPlus, Image as ImageIcon, Maximize2, MessageSquare, Minus, Pencil, Plus, RefreshCw, Scissors, Trash2, Upload, Video } from "lucide-react";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "../types";
import { useConfigStore } from "@/stores/use-config-store";
import { canOpenNodeGenerationDialog, canSaveNodeAsAsset } from "./canvas-node-actions";

type CanvasNodeHoverToolbarProps = {
    node: CanvasNodeData | null;
    viewport: ViewportTransform;
    onKeep: (nodeId: string) => void;
    onLeave: () => void;
    onEditText: (node: CanvasNodeData) => void;
    onDecreaseFont: (node: CanvasNodeData) => void;
    onIncreaseFont: (node: CanvasNodeData) => void;
    onToggleDialog: (node: CanvasNodeData) => void;
    onGenerateImage: (node: CanvasNodeData) => void;
    onUpload: (node: CanvasNodeData) => void;
    onDownload: (node: CanvasNodeData) => void;
    onSaveAsset: (node: CanvasNodeData) => void;
    onCrop: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    onViewImage: (node: CanvasNodeData) => void;
    onMask: (node: CanvasNodeData) => void;
    onRetry: (node: CanvasNodeData) => void;
    onDelete: (node: CanvasNodeData) => void;
};

export function CanvasNodeHoverToolbar({
    node,
    viewport,
    onKeep,
    onLeave,
    onEditText,
    onDecreaseFont,
    onIncreaseFont,
    onToggleDialog,
    onGenerateImage,
    onUpload,
    onDownload,
    onSaveAsset,
    onCrop,
    onAngle,
    onViewImage,
    onMask,
    onRetry,
    onDelete,
}: CanvasNodeHoverToolbarProps) {
	const supportsMask = useConfigStore((state) => state.status?.imageRequestSchema?.supportsMask ?? true);
    if (!node) return null;

    const left = viewport.x + (node.position.x + node.width / 2) * viewport.k;
    const top = viewport.y + node.position.y * viewport.k - 14;
    const isImage = node.type === CanvasNodeType.Image;
    const isVideo = node.type === CanvasNodeType.Video;
    const hasImage = isImage && Boolean(node.metadata?.content);
    const hasVideo = isVideo && Boolean(node.metadata?.content);
    const isText = node.type === CanvasNodeType.Text;
    const canOpenDialog = canOpenNodeGenerationDialog(node);
    const retryingLocalUpload = node.metadata?.localUploadState === "failed";
    const canRetry = node.metadata?.status === "error" || retryingLocalUpload;
    const canDeleteLocalUpload = Boolean(node.metadata?.localUploadState);
    const hasSpecificTools = canRetry || isText || isImage || isVideo;

    if (!hasSpecificTools) return null;

    return (
        <div
            className="absolute z-[70] flex h-12 -translate-x-1/2 -translate-y-full items-center overflow-visible rounded-[18px] border border-black/10 bg-white text-[15px] text-[#242529] shadow-[0_8px_28px_rgba(15,23,42,.12)]"
            style={{ left, top }}
            onMouseEnter={() => onKeep(node.id)}
            onMouseLeave={onLeave}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {canRetry ? <ToolbarAction title={retryingLocalUpload ? "重新上传" : "重新生成"} label="重试" icon={<RefreshCw className="size-4" />} onClick={() => onRetry(node)} /> : null}
            {canDeleteLocalUpload ? <ToolbarAction title="删除本地图片" label="删除" icon={<Trash2 className="size-4" />} onClick={() => onDelete(node)} /> : null}
            {canSaveNodeAsAsset(node) ? <ToolbarAction title="加入我的素材" label="存素材" icon={<FolderPlus className="size-4" />} onClick={() => onSaveAsset(node)} /> : null}
            {hasImage || hasVideo ? <IconAction title={hasVideo ? "下载视频" : "下载图片"} icon={<Download className="size-5" />} onClick={() => onDownload(node)} /> : null}
            {canOpenDialog ? <ToolbarAction title="编辑" label="编辑" icon={<MessageSquare className="size-4" />} onClick={() => onToggleDialog(node)} /> : null}
            {isText ? <ToolbarAction title="编辑文本" label="编辑文字" icon={<Pencil className="size-4" />} onClick={() => onEditText(node)} /> : null}
            {isText ? <ToolbarAction title="用文本生图" label="生图" icon={<ImageIcon className="size-4" />} onClick={() => onGenerateImage(node)} /> : null}
            {isText ? <ToolbarAction title="减小字号" label="缩小" icon={<Minus className="size-4" />} onClick={() => onDecreaseFont(node)} /> : null}
            {isText ? <ToolbarAction title="增大字号" label="放大" icon={<Plus className="size-4" />} onClick={() => onIncreaseFont(node)} /> : null}
            {isImage ? <ToolbarAction title={hasImage ? "替换图片" : "上传图片"} label={hasImage ? "替换图片" : "上传图片"} icon={<Upload className="size-4" />} onClick={() => onUpload(node)} /> : null}
            {isVideo ? <ToolbarAction title={hasVideo ? "替换视频" : "上传视频"} label={hasVideo ? "替换视频" : "上传视频"} icon={<Video className="size-4" />} onClick={() => onUpload(node)} /> : null}
            {hasImage && supportsMask ? <ToolbarAction title="编辑遮罩" label="遮罩" icon={<Brush className="size-4" />} onClick={() => onMask(node)} /> : null}
            {hasImage ? <ToolbarAction title="裁剪并生成新节点" label="裁剪" icon={<Scissors className="size-4" />} onClick={() => onCrop(node)} /> : null}
            {hasImage ? <ToolbarAction title="生成角度" label="多角度" icon={<Camera className="size-4" />} onClick={() => onAngle(node)} /> : null}
            {hasImage ? <ToolbarAction title="查看图片详情" label="查看大图" icon={<Maximize2 className="size-4" />} onClick={() => onViewImage(node)} /> : null}
        </div>
    );
}


function ToolbarAction({ title, label, icon, onClick, hint, active = false }: { title: string; label: string; icon: ReactNode; onClick?: () => void; hint?: string; active?: boolean }) {
    return (
        <Tooltip title={title} placement="top" mouseEnterDelay={0.2}>
            <button type="button" className="group relative flex h-12 items-center whitespace-nowrap px-1.5" onClick={onClick} aria-label={title}>
                <span className={`flex h-9 items-center gap-2 rounded-lg px-2.5 transition group-hover:bg-[#f0f0f1] ${active ? "bg-[#eeeeef]" : ""}`}>
                    {icon}
                    <span>{label}</span>
                    {hint ? <span className="text-[#a3a3a3]">{hint}</span> : null}
                </span>
            </button>
        </Tooltip>
    );
}

function IconAction({ title, icon, onClick }: { title: string; icon: ReactNode; onClick: () => void }) {
    return (
        <Tooltip title={title} placement="top" mouseEnterDelay={0.2}>
            <button type="button" className="group relative grid h-12 w-12 place-items-center px-1.5" onClick={onClick} aria-label={title}>
                <span className="grid size-9 place-items-center rounded-lg transition group-hover:bg-[#f0f0f1]">{icon}</span>
            </button>
        </Tooltip>
    );
}
