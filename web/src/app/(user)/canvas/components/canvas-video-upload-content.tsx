"use client";
import type { LocalVideoUploadView } from "../media/canvas-local-video-upload-controller";
import { CanvasVideoContent } from "./canvas-video-content";

export function CanvasVideoUploadContent({ nodeId, upload, visible, onRetry, onCancel }: { nodeId: string; upload: LocalVideoUploadView; visible?: boolean; onRetry: () => void; onCancel: () => void }) {
    return (
        <div className="relative h-full w-full">
            <CanvasVideoContent nodeId={nodeId} legacyURL={upload.url} visible={visible} />
            {upload.stage !== "ready" && (
                <div role="status" className="absolute inset-x-2 top-2 rounded-lg bg-black/80 p-2 text-xs text-white">
                    <div className="flex items-center justify-between gap-2">
                        <span>{upload.stage === "failed" ? "视频上传失败" : upload.stage === "verifying" ? "正在完成上传…" : `视频上传中 ${upload.progress}%`}</span>
                        <span className="flex shrink-0 gap-2" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                            {upload.stage === "failed" && (
                                <button type="button" className="underline" onClick={onRetry}>
                                    重试上传
                                </button>
                            )}
                            <button type="button" className="underline" onClick={onCancel}>
                                取消上传
                            </button>
                        </span>
                    </div>
                    {upload.stage === "uploading" && <progress aria-label="视频上传进度" value={upload.progress} max={100} className="mt-2 block h-1 w-full accent-blue-500" />}
                    {upload.stage === "failed" && (
                        <div role="alert" className="mt-1 break-words text-red-300">
                            {upload.error}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
