"use client";
import type { LocalVideoUploadView } from "../media/canvas-local-video-upload-controller";
import { CanvasVideoContent } from "./canvas-video-content";
import { CanvasMediaUploadStatus } from "./canvas-media-upload-status";

export function CanvasVideoUploadContent({ nodeId, upload, visible, onRetry, onCancel }: { nodeId: string; upload: LocalVideoUploadView; visible?: boolean; onRetry: () => void; onCancel: () => void }) {
    return (
        <div className="relative h-full w-full">
            <CanvasVideoContent nodeId={nodeId} legacyURL={upload.url} visible={visible} />
            {upload.stage !== "ready" && <CanvasMediaUploadStatus stage={upload.stage} progress={upload.progress} error={upload.error} onRetry={onRetry} onCancel={onCancel} className="bottom-14" />}
        </div>
    );
}
