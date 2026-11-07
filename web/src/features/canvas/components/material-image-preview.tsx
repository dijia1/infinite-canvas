"use client";

import { Modal } from "antd";
import { ImageOff } from "lucide-react";
import { CanvasVideoContent, ScopedVideoResourceProvider } from "./canvas-video-content";
import type { MaterialVideoPreview } from "./material-video-card";

export type MaterialImagePreview = { title: string; url: string };

export function MaterialImagePreviewModal({ preview, onClose }: { preview?: MaterialImagePreview; onClose: () => void }) {
    return (
        <Modal open={Boolean(preview)} title={preview?.title} footer={null} onCancel={onClose} width="min(90vw, 72rem)">
            {preview ? <img src={preview.url} alt={preview.title} className="max-h-[75vh] w-full object-contain" /> : null}
        </Modal>
    );
}

export function MaterialBrokenImagePlaceholder() {
    return (
        <div className="flex aspect-[4/3] flex-col items-center justify-center gap-1 bg-stone-100 text-xs text-stone-500 dark:bg-stone-800 dark:text-stone-400">
            <ImageOff className="size-5" aria-hidden />
            <span>图片已损坏</span>
        </div>
    );
}

export function MaterialVideoPreviewModal({ preview, onClose }: { preview?: MaterialVideoPreview; onClose: () => void }) {
    return (
        <Modal open={Boolean(preview)} title={preview?.title} footer={null} onCancel={onClose} width="min(90vw, 64rem)" destroyOnHidden>
            {preview ? <ScopedVideoResourceProvider scope={`material:${preview.mediaId}`} nodeIds={[preview.mediaId]}><div className="h-[min(70vh,640px)]"><CanvasVideoContent nodeId={preview.mediaId} mediaId={preview.mediaId} /></div></ScopedVideoResourceProvider> : null}
        </Modal>
    );
}
