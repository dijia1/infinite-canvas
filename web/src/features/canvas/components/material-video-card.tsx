"use client";

import { Play, RefreshCw, Video } from "lucide-react";
import { useCallback, useState, type MouseEvent } from "react";
import { getVideoMediaAccess } from "@/services/api/video-media";
import type { VideoAsset } from "@/stores/use-asset-store";
import { PRIVATE_VIDEO_DRAG_TYPE } from "./material-image-drag";
import { useMaterialMediaPreview } from "./use-material-media-preview";

export type MaterialVideoPreview = { title: string; mediaId: string };
type Props = { asset: VideoAsset; onPreview: (preview: MaterialVideoPreview) => void; onContextMenu: (asset: VideoAsset, event: MouseEvent) => void };

export function MaterialVideoCard(props: Props) {
    const [attempt, setAttempt] = useState(0);
    return <VideoCardPreview key={`${props.asset.id}:${attempt}`} {...props} onRetry={() => setAttempt(value => value + 1)} />;
}

function VideoCardPreview({ asset, onPreview, onContextMenu, onRetry }: Props & { onRetry: () => void }) {
    const mediaId = typeof asset.metadata?.mediaId === "string" ? asset.metadata.mediaId : "";
    const loadAccess = useCallback(async () => {
        const access = await getVideoMediaAccess(mediaId);
        if (!access.previewUrl) throw new Error("视频封面暂不可用，请重试");
        return access;
    }, [mediaId]);
    const { ref, url, error, loading } = useMaterialMediaPreview({ identity: asset.id, mediaId, enabled: Boolean(mediaId), loadAccess });
    const [decodeFailed, setDecodeFailed] = useState(false);
    const failed = Boolean(error) || decodeFailed;
    return (
        <div
            ref={ref}
            data-material-card
            data-material-video
            draggable={Boolean(mediaId)}
            role="button"
            tabIndex={0}
            aria-label={`预览视频 ${asset.title}`}
            className="group relative cursor-grab overflow-hidden rounded-lg border border-stone-200 bg-black active:cursor-grabbing dark:border-stone-700"
            onDragStart={event => { event.dataTransfer.effectAllowed = "copyMove"; event.dataTransfer.setData(PRIVATE_VIDEO_DRAG_TYPE, JSON.stringify({ assetId: asset.id })); }}
            onClick={() => { if (mediaId) onPreview({ title: asset.title, mediaId }); }}
            onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (mediaId) onPreview({ title: asset.title, mediaId }); } }}
            onContextMenu={event => onContextMenu(asset, event)}
            title={`${asset.title} · 点击播放，拖入画布使用；右键管理`}
        >
            {url && !failed ? <img src={url} alt={asset.title} draggable={false} className="aspect-[4/3] w-full object-cover" onError={() => setDecodeFailed(true)} /> : <div className={`flex aspect-[4/3] items-center justify-center bg-stone-800 text-stone-300 ${loading ? "animate-pulse" : ""}`}><Video className="size-5" /></div>}
            <span className="pointer-events-none absolute bottom-1 left-1 inline-flex items-center gap-1 rounded bg-black/70 px-1 py-0.5 text-[10px] text-white"><Play className="size-2.5" />{asset.data.duration ? `${asset.data.duration.toFixed(1)}s` : "视频"}</span>
            {failed ? <button type="button" aria-label={`重试封面 ${asset.title}`} className="absolute right-1 top-1 rounded bg-black/75 p-1 text-white" onClick={event => { event.stopPropagation(); onRetry(); }}><RefreshCw className="size-3" /></button> : null}
        </div>
    );
}
