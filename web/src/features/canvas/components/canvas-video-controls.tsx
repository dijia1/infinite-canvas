"use client";

import { useEffect, useState, type RefObject } from "react";
import { Maximize, Pause, Play, Volume2, VolumeX } from "lucide-react";

export type CanvasVideoElement = HTMLVideoElement & {
    webkitDisplayingFullscreen?: boolean;
    webkitEnterFullscreen?: () => void;
};

const buttonClass = "pointer-events-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-white/20 focus-visible:outline focus-visible:outline-white";

function formatTime(seconds: number) {
    const wholeSeconds = Math.floor(seconds);
    return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

export function CanvasVideoControls({ videoRef, playing, onTogglePlayback }: {
    videoRef: RefObject<CanvasVideoElement | null>;
    playing: boolean;
    onTogglePlayback: () => void;
}) {
    const [media, setMedia] = useState({ time: 0, duration: 0, volume: 1, muted: false });
    const [fullscreenError, setFullscreenError] = useState(false);
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        const update = () => setMedia({
            time: video.currentTime,
            duration: Number.isFinite(video.duration) ? video.duration : 0,
            volume: video.volume,
            muted: video.muted,
        });
        const events = ["timeupdate", "durationchange", "volumechange", "emptied"] as const;
        for (const event of events) video.addEventListener(event, update);
        update();
        return () => {
            for (const event of events) video.removeEventListener(event, update);
        };
    }, [videoRef]);

    const openFullscreen = async () => {
        const video = videoRef.current;
        if (!video) return;
        setFullscreenError(false);
        try {
            if (document.fullscreenEnabled) await video.requestFullscreen();
            else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
            else setFullscreenError(true);
        } catch {
            setFullscreenError(true);
        }
    };
    const time = Math.min(media.time, media.duration);
    const progress = media.duration > 0 ? `${formatTime(time)} / ${formatTime(media.duration)}` : formatTime(time);
    const silent = media.muted || media.volume === 0;
    return (
        <div className="pointer-events-none absolute inset-0 text-white"
            onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
            <button type="button" aria-label={playing ? "暂停视频" : "播放视频"} onClick={onTogglePlayback}
                className={playing
                    ? `${buttonClass} absolute bottom-1 left-2 z-10`
                    : "pointer-events-auto absolute left-1/2 top-1/2 z-10 flex size-12 max-h-[42%] max-w-[32%] -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-black/65 hover:bg-black/85 focus-visible:outline focus-visible:outline-white"}>
                {playing ? <Pause aria-hidden="true" className="size-4" /> : <Play aria-hidden="true" className="size-5 fill-current" />}
            </button>
            <div className={`absolute inset-x-0 bottom-0 flex h-12 items-center gap-1.5 bg-gradient-to-t from-black/90 to-transparent px-2 pt-4 pb-1 ${playing ? "pl-10" : ""}`}>
                <input type="range" aria-label="视频进度" aria-valuetext={progress}
                    min={0} max={media.duration} step={0.01} value={time} disabled={media.duration <= 0}
                    className="pointer-events-auto h-7 min-w-0 flex-1 cursor-pointer accent-white disabled:pointer-events-none"
                    onChange={event => {
                        const video = videoRef.current;
                        if (video) video.currentTime = Number(event.currentTarget.value);
                    }} />
                <span aria-hidden="true" className="hidden shrink-0 text-[11px] tabular-nums @[300px]/video:block">{progress}</span>
                <button type="button" aria-label={silent ? "取消静音" : "静音"} className={buttonClass} onClick={() => {
                    const video = videoRef.current;
                    if (!video) return;
                    if (silent && video.volume === 0) video.volume = 1;
                    video.muted = !silent;
                }}>
                    {silent ? <VolumeX aria-hidden="true" className="size-4" /> : <Volume2 aria-hidden="true" className="size-4" />}
                </button>
                <input type="range" aria-label="视频音量" min={0} max={1} step={0.05} value={silent ? 0 : media.volume}
                    className="pointer-events-auto hidden h-7 w-12 min-w-0 cursor-pointer accent-white @[180px]/video:block"
                    onChange={event => {
                        const video = videoRef.current;
                        if (!video) return;
                        video.volume = Number(event.currentTarget.value);
                        video.muted = false;
                    }} />
                <button type="button" aria-label="全屏播放" className={buttonClass} onClick={() => void openFullscreen()}>
                    <Maximize aria-hidden="true" className="size-4" />
                </button>
            </div>
            {fullscreenError ? <div role="status" className="absolute inset-x-0 bottom-10 text-center text-xs drop-shadow">无法进入全屏</div> : null}
        </div>
    );
}
