"use client";

import { Image as ImageIcon, Video } from "lucide-react";

import { CanvasVideoContent } from "@/app/(user)/canvas/components/canvas-video-content";
import { CanvasReadyImage } from "@/components/canvas-ready-image";

export function WorkflowMediaPreview({
    nodeId,
    mediaId,
    type,
    visible = true,
    readOnly = false,
    imageUrl,
    imageStorageKey,
    imageError,
    onRetryImage,
    onImageLoaded,
    onImageDimensions,
    onChoose,
}: {
    nodeId: string;
    mediaId?: string;
    type: "image" | "video";
    visible?: boolean;
    readOnly?: boolean;
    imageUrl?: string;
    imageStorageKey?: string;
    imageError?: string;
    onRetryImage?: () => void;
    onImageLoaded?: (storageKey: string) => void;
    onImageDimensions?: (dimensions: { width: number; height: number }) => void;
    onChoose?: () => void;
}) {
    if (!mediaId && !(type === "image" && imageUrl)) {
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-xs opacity-55">
                {type === "image" ? <ImageIcon className="size-7" /> : <Video className="size-7" />}
                <button type="button" disabled={readOnly} className="rounded-md border px-2 py-1 disabled:cursor-default" onClick={onChoose} onPointerDown={(event) => event.stopPropagation()}>
                    选择或上传
                </button>
            </div>
        );
    }
    if (type === "video") return <CanvasVideoContent nodeId={nodeId} mediaId={mediaId} visible={visible} />;
    return (
        <CanvasReadyImage
            key={mediaId}
            src={imageUrl}
            alt=""
            error={imageError}
            onRetry={onRetryImage}
            onReady={(image) => {
                if (imageStorageKey) onImageLoaded?.(imageStorageKey);
                onImageDimensions?.({ width: image.naturalWidth, height: image.naturalHeight });
            }}
        />
    );
}
