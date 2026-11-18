"use client";
import type { LocalVideoUploadView } from "../media/canvas-local-video-upload-controller";
import { CanvasVideoContent } from "./canvas-video-content";
import { CanvasMediaUploadStatus } from "./canvas-media-upload-status";

export function CanvasVideoUploadContent({ nodeId, upload, visible, preloadMetadata, onRetry, onCancel }: { nodeId: string; upload: LocalVideoUploadView; visible?: boolean; preloadMetadata?: boolean; onRetry: () => void; onCancel: () => void }) {
    return (
        <div className="relative h-full w-full">
            <CanvasVideoContent nodeId={nodeId} legacyURL={upload.url} visible={visible} draggable preloadMetadata={preloadMetadata} />
            {upload.stage !== "ready" && <CanvasMediaUploadStatus stage={upload.stage} progress={upload.progress} error={upload.error} onRetry={onRetry} onCancel={onCancel} className="bottom-14" />}
        </div>
    );
}
