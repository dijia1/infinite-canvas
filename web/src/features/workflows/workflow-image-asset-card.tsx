"use client";

import { ImageOff, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";

import { useMaterialMediaPreview } from "@/features/canvas/components/use-material-media-preview";
import { getRemoteImageAccess } from "@/services/image-storage";

type Props = { mediaId: string; title: string; onSelect: () => void };

export function WorkflowImageAssetCard(props: Props) {
    const [attempt, setAttempt] = useState(0);
    // Remounting releases the previous preview before an explicit retry.
    return <ImageAssetPreview key={`${props.mediaId}:${attempt}`} {...props} onRetry={() => setAttempt((value) => value + 1)} />;
}

function ImageAssetPreview({ mediaId, title, onSelect, onRetry }: Props & { onRetry: () => void }) {
    const loadAccess = useCallback(() => getRemoteImageAccess(mediaId), [mediaId]);
    const { ref, url, error, loading } = useMaterialMediaPreview({ identity: mediaId, mediaId, enabled: true, loadAccess });
    const [decodeFailed, setDecodeFailed] = useState(false);
    const failed = Boolean(error) || decodeFailed;

    return (
        <div ref={ref} data-workflow-image-asset className="relative overflow-hidden rounded-xl border border-stone-200 dark:border-stone-700">
            <button type="button" aria-label={title} className="block w-full text-left" onClick={onSelect}>
                {failed ? (
                    <span className="flex aspect-[4/3] items-center justify-center bg-stone-100 text-stone-500 dark:bg-stone-900 dark:text-stone-400" aria-label="缩略图加载失败">
                        <ImageOff className="size-6" />
                    </span>
                ) : url ? (
                    <img src={url} alt={title} draggable={false} className="aspect-[4/3] w-full object-cover" onError={() => setDecodeFailed(true)} />
                ) : (
                    <span role="status" aria-label={loading ? "正在加载缩略图" : "等待加载缩略图"} className="block aspect-[4/3] animate-pulse bg-stone-100 dark:bg-stone-800" />
                )}
                <span className="block truncate px-2 py-1.5 text-xs" title={title}>{title}</span>
            </button>
            {failed ? (
                <button type="button" aria-label={`重试加载 ${title}`} className="absolute right-1 top-1 inline-flex items-center gap-1 rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-200" onClick={onRetry}>
                    <RefreshCw className="size-3.5" />重试
                </button>
            ) : null}
        </div>
    );
}
