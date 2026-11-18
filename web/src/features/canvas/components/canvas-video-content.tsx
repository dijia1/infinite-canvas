"use client";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createVideoResourceManager, type VideoResourceLease, type VideoResourceManager } from "../media/video-resource-manager";
import { useCanvasStore } from "../stores/use-canvas-store";

import type { VideoGenerationSource } from "@/services/api/video";
import type { CanvasTheme } from "@/lib/canvas-theme";

type FinalVideoAction = (nodeId: string, source: VideoGenerationSource, mediaId: string) => void | Promise<void>;
type Playback = { time: number; volume: number; muted: boolean; rate: number };
type Resources = { manager: VideoResourceManager; playback: Map<string, Playback>; onGenerateFinal?: FinalVideoAction; finalActionLabel?: string };
const Context = createContext<Resources | null>(null);
export function VideoResourceProvider({ projectId, nodeIds, children, onGenerateFinal }: { projectId: string; nodeIds: string[]; children: ReactNode; onGenerateFinal?: FinalVideoAction }) {
    const scope = useCanvasStore((s) => s.syncScope);
    return (
        <ScopedVideoResourceProvider scope={`${scope}:${projectId}`} nodeIds={nodeIds} onGenerateFinal={onGenerateFinal} resetOnCanvasScopeChange>
            {children}
        </ScopedVideoResourceProvider>
    );
}

export function ScopedVideoResourceProvider({
    scope,
    nodeIds,
    children,
    onGenerateFinal,
    finalActionLabel,
    resetOnCanvasScopeChange = false,
}: {
    scope: string;
    nodeIds: string[];
    children: ReactNode;
    onGenerateFinal?: FinalVideoAction;
    finalActionLabel?: string;
    resetOnCanvasScopeChange?: boolean;
}) {
    const resources = useMemo<Resources>(() => ({ manager: createVideoResourceManager(), playback: new Map() }), [scope]);
    useLayoutEffect(() => {
        const reset = () => {
            resources.manager.resetSession();
            resources.playback.clear();
        };
        const unsubscribe = resetOnCanvasScopeChange ? useCanvasStore.subscribe((state, previous) => {
            if (state.syncScope !== previous.syncScope) reset();
        }) : () => undefined;
        return () => {
            unsubscribe();
            reset();
        };
    }, [resetOnCanvasScopeChange, resources]);
    useEffect(() => {
        const ids = new Set(nodeIds);
        for (const id of resources.playback.keys()) if (!ids.has(id)) resources.playback.delete(id);
    }, [nodeIds, resources]);
    return <Context.Provider value={{ ...resources, onGenerateFinal, finalActionLabel }}>{children}</Context.Provider>;
}

function VideoFinalActionButton({ nodeId, mediaId, source, onGenerate, label = "生成正式片 · 1080p", theme }: { nodeId: string; mediaId: string; source: VideoGenerationSource; onGenerate: FinalVideoAction; label?: string; theme?: CanvasTheme }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const pending = useRef(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    return <>
        <button
            type="button"
            disabled={busy}
            className="cursor-pointer whitespace-nowrap rounded border border-white/25 px-2 py-1 disabled:opacity-50"
            style={theme ? { background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text } : undefined}
            onClick={async () => {
                if (pending.current) return;
                pending.current = true;
                setBusy(true);
                setError("");
                try {
                    await onGenerate(nodeId, source, mediaId);
                } catch (e) {
                    if (mounted.current) setError(e instanceof Error ? e.message : "无法生成正式片");
                } finally {
                    pending.current = false;
                    if (mounted.current) setBusy(false);
                }
            }}
        >{busy ? "处理中…" : label}</button>
        {error ? <span role="alert" className={`order-last w-full break-words ${theme ? "text-red-500" : "text-red-300"}`}>{error}</span> : null}
    </>;
}

// Result panels share the player's cached metadata without remounting it.
export function useVideoGenerationSource(mediaId?: string) {
    const manager = useContext(Context)?.manager;
    const [result, setResult] = useState<{ mediaId?: string; generation?: VideoGenerationSource; error?: string }>({});
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        if (!manager || !mediaId) return;
        const lease = manager.acquire(mediaId);
        let live = true;
        void lease.getAccess().then(value => {
            if (live) setResult({ mediaId, generation: value.videoGeneration });
        }).catch(e => {
            if (live) setResult({ mediaId, error: e instanceof Error ? e.message : "样片信息加载失败" });
        });
        return () => {
            live = false;
            lease.release();
        };
    }, [manager, mediaId, retry]);
    return {
        generation: result.mediaId === mediaId ? result.generation : undefined,
        error: result.mediaId === mediaId ? result.error : undefined,
        retry: () => { setResult({}); setRetry(value => value + 1); },
    };
}

export function CanvasVideoFinalAction({ nodeId, mediaId, theme }: { nodeId: string; mediaId: string; theme: CanvasTheme }) {
    const onGenerate = useContext(Context)?.onGenerateFinal;
    const { generation, error, retry } = useVideoGenerationSource(onGenerate ? mediaId : undefined);
    if (!onGenerate) return null;
    if (error) return <span role="alert" className="text-red-500">
        {error}{" "}<button type="button" className="underline" onClick={retry}>重试</button>
    </span>;
    if (generation?.mode !== "draft") return null;
    return <VideoFinalActionButton key={`${nodeId}:${mediaId}:${generation.taskId}`} nodeId={nodeId} mediaId={mediaId} source={generation} onGenerate={onGenerate} theme={theme} />;
}

export function CanvasVideoContent({ nodeId, mediaId, legacyURL, visible = true, draggable = false, preloadMetadata = false, showGenerationFooter = true, onDimensions }: {
    nodeId: string;
    mediaId?: string;
    legacyURL?: string;
    visible?: boolean;
    draggable?: boolean;
    preloadMetadata?: boolean;
    showGenerationFooter?: boolean;
    onDimensions?: (dimensions: { width: number; height: number }) => void;
}) {
    const naturalSizeRef = useRef<{ width: number; height: number } | undefined>(undefined);
    const dimensionsRef = useRef(onDimensions);
    dimensionsRef.current = onDimensions;
    const context = useContext(Context);
    const resources = useMemo(() => (context ? { manager: context.manager, playback: context.playback } : null), [context?.manager, context?.playback]);
    const [generation, setGeneration] = useState<VideoGenerationSource>();
    const videoRef = useRef<HTMLVideoElement>(null);
    const leaseRef = useRef<VideoResourceLease | undefined>(undefined);
    const attempt = useRef(0),
        recovering = useRef(false),
        restored = useRef(false),
        wantsPlay = useRef(false);
    const switching = useRef(false),
        failed = useRef(false);
    const snapshot = useRef<Playback | undefined>(undefined);
    const recoveryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [poster, setPoster] = useState<string>();
    const [source, setSource] = useState<string>();
    const [busy, setBusy] = useState(false),
        [error, setError] = useState("");
    const [external, setExternal] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [buffering, setBuffering] = useState(false);
    const save = () => {
        const video = videoRef.current;
        if (video && video.readyState > 0 && resources && Number.isFinite(video.currentTime)) resources.playback.set(nodeId, { time: video.currentTime, volume: video.volume, muted: video.muted, rate: video.playbackRate });
    };
    useLayoutEffect(() => {
        setSource(undefined);
        setGeneration(undefined);
        naturalSizeRef.current = undefined;
        setPoster(undefined);
        setBusy(false);
        setError("");
        recovering.current = false;
        failed.current = false;
        setPlaying(false);
        setBuffering(false);
        attempt.current++;
        snapshot.current = resources?.playback.get(nodeId);
        return () => {
            attempt.current++;
            clearTimeout(recoveryTimer.current);
        };
    }, [resources, mediaId, nodeId]);
    // Editing permission may arrive after cached metadata. Deliver it once the
    // caller can accept layout changes without fetching the resource again.
    useEffect(() => {
        if (onDimensions && naturalSizeRef.current) dimensionsRef.current?.(naturalSizeRef.current);
    }, [Boolean(onDimensions), mediaId]);
    useEffect(() => {
        if (!resources || !mediaId || (!visible && !source && !external)) return;
        const lease = resources.manager.acquire(mediaId);
        leaseRef.current = lease;
        let live = true;
        if (visible && !source)
            void lease
                .getAccess()
                .then((value) => {
                    if (live) {
                        setSource(value.url);
                        setGeneration(value.videoGeneration);
                        if (value.width > 0 && value.height > 0) {
                            naturalSizeRef.current = { width: value.width, height: value.height };
                            dimensionsRef.current?.(naturalSizeRef.current);
                        }
                    }
                })
                .catch((e) => {
                    if (live) setError(e instanceof Error ? e.message : "视频地址加载失败");
                });
        if (visible)
            void lease
                .getPoster()
                .then((url) => {
                    if (live) setPoster(url);
                })
                .catch(() => {});
        return () => {
            live = false;
            if (leaseRef.current === lease) leaseRef.current = undefined;
            setPoster(undefined);
            lease.release();
        };
    }, [resources, mediaId, visible, Boolean(source), external]);
    useEffect(() => {
        if (visible && !mediaId && legacyURL) setSource(legacyURL);
    }, [visible, mediaId, legacyURL]);
    // Generated videos can lack stored dimensions. The cached first frame gives
    // their aspect ratio without preloading the video just to measure it.
    useEffect(() => {
        if (!onDimensions || !poster || naturalSizeRef.current) return;
        const image = new Image();
        image.onload = () => {
            naturalSizeRef.current = { width: image.naturalWidth, height: image.naturalHeight };
            dimensionsRef.current?.(naturalSizeRef.current);
        };
        image.onerror = () => console.warn("读取视频封面尺寸失败", { mediaId });
        image.src = poster;
        return () => {
            image.onload = null;
            image.onerror = null;
            image.removeAttribute("src");
        };
    }, [poster, Boolean(onDimensions), mediaId]);
    useEffect(() => {
        if (source && switching.current) videoRef.current?.load();
    }, [source]);
    useEffect(() => {
        if (visible || external) return;
        wantsPlay.current = false;
        setBuffering(false);
        videoRef.current?.pause();
        save();
        const timer = setTimeout(() => {
            save();
            setSource(undefined);
            setGeneration(undefined);
        }, 10000);
        return () => clearTimeout(timer);
    }, [visible, external, source]);
    useLayoutEffect(
        () => () => {
            save();
            const video = videoRef.current;
            video?.pause();
            video?.removeAttribute("src");
            video?.load();
        },
        [resources, nodeId, mediaId],
    );
    useEffect(() => {
        const update = () => setExternal(Boolean(videoRef.current && (document.fullscreenElement === videoRef.current || document.pictureInPictureElement === videoRef.current)));
        const video = videoRef.current;
        document.addEventListener("fullscreenchange", update);
        video?.addEventListener("enterpictureinpicture", update);
        video?.addEventListener("leavepictureinpicture", update);
        return () => {
            document.removeEventListener("fullscreenchange", update);
            video?.removeEventListener("enterpictureinpicture", update);
            video?.removeEventListener("leavepictureinpicture", update);
        };
    }, [source]);
    const fail = (text: string) => {
        attempt.current++;
        failed.current = true;
        wantsPlay.current = false;
        clearTimeout(recoveryTimer.current);
        switching.current = false;
        videoRef.current?.pause();
        setBusy(false);
        setBuffering(false);
        setError(text);
    };
    const begin = async () => {
        if (busy) return;
        const generation = ++attempt.current;
        setError("");
        setBusy(true);
        failed.current = false;
        recovering.current = false;
        switching.current = true;
        restored.current = false;
        wantsPlay.current = true;
        snapshot.current = resources?.playback.get(nodeId);
        try {
            const lease = leaseRef.current;
            const url = mediaId ? (await lease?.getAccess())?.url : legacyURL;
            if (generation !== attempt.current) return;
            if (!url) throw Error("视频尚未上传完成");
            setSource(url);
            if (videoRef.current?.getAttribute("src") === url) videoRef.current.load();
            recoveryTimer.current = setTimeout(() => {
                if (generation === attempt.current) fail("视频加载超时，点击重试");
            }, 20000);
        } catch (e) {
            if (generation === attempt.current) fail(e instanceof Error ? e.message : "视频加载失败");
        }
    };
    const resume = () => {
        const video = videoRef.current;
        if (!video || failed.current) return;
        clearTimeout(recoveryTimer.current);
        setBusy(false);
        switching.current = false;
        if (wantsPlay.current)
            void video.play().catch(() => {
                setBusy(false);
                setBuffering(false);
                wantsPlay.current = false;
            });
    };
    const loaded = () => {
        const video = videoRef.current;
        if (!video || failed.current) return;
        naturalSizeRef.current = { width: video.videoWidth, height: video.videoHeight };
        dimensionsRef.current?.(naturalSizeRef.current);
        const value = snapshot.current;
        if (!restored.current && value) {
            restored.current = true;
            video.volume = value.volume;
            video.muted = value.muted;
            video.playbackRate = value.rate;
            const time = Math.max(0, Math.min(value.time, Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : value.time));
            if (time > 0.05) {
                video.currentTime = time;
                return;
            }
        }
        resume();
    };
    const playbackError = async () => {
        const video = videoRef.current;
        if (!video || !source || failed.current) return;
        clearTimeout(recoveryTimer.current);
        if (video.error?.code !== 2 || recovering.current || !leaseRef.current) {
            fail("视频无法播放，点击重试");
            return;
        }
        recovering.current = true;
        switching.current = true;
        save();
        snapshot.current = resources?.playback.get(nodeId);
        restored.current = false;
        const generation = attempt.current;
        setBusy(true);
        try {
            const value = await leaseRef.current.refreshAfterFailure(source);
            if (generation !== attempt.current) return;
            setSource(value.url);
            if (value.url === source) video.load();
            clearTimeout(recoveryTimer.current);
            recoveryTimer.current = setTimeout(() => fail("视频恢复超时，点击重试"), 20000);
        } catch (e) {
            if (generation === attempt.current) fail(e instanceof Error ? e.message : "视频恢复失败，点击重试");
        }
    };
    return (
        <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[18px] bg-black">
            <div className="relative min-h-0 flex-1">
                {visible || source ? (
                <video
                    ref={videoRef}
                    data-video-node-id={nodeId}
                    src={source}
                    controls
                    poster={poster}
                    preload={visible && preloadMetadata ? "metadata" : "none"}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    playsInline
                    className="h-full w-full object-contain"
                    onLoadedMetadata={loaded}
                    onSeeking={({ currentTarget: video }) => setBuffering(video.readyState < video.HAVE_FUTURE_DATA)}
                    onSeeked={(event) => {
                        const video = event.currentTarget;
                        if (video.paused || video.readyState >= video.HAVE_FUTURE_DATA) setBuffering(false);
                        resume();
                    }}
                    onError={() => void playbackError()}
                    onPlay={({ currentTarget: video }) => {
                        wantsPlay.current = true;
                        setPlaying(true);
                        setBuffering(video.readyState < video.HAVE_FUTURE_DATA);
                        if (!switching.current && video.readyState === video.HAVE_NOTHING) {
                            clearTimeout(recoveryTimer.current);
                            recoveryTimer.current = setTimeout(() => fail("视频加载超时，点击重试"), 20000);
                        }
                    }}
                    onWaiting={(event) => {
                        if (!event.currentTarget.paused) setBuffering(true);
                    }}
                    onPlaying={() => setBuffering(false)}
                    onPause={() => {
                        setPlaying(false);
                        setBuffering(false);
                        if (!switching.current && !videoRef.current?.error) {
                            wantsPlay.current = false;
                            clearTimeout(recoveryTimer.current);
                        }
                        save();
                    }}
                    onEnded={() => {
                        wantsPlay.current = false;
                        setPlaying(false);
                        setBuffering(false);
                        save();
                    }}
                    onTimeUpdate={save}
                />
            ) : poster ? (
                <img src={poster} alt="视频封面" className="h-full w-full object-contain" onError={() => setPoster(undefined)} />
            ) : (
                <div className="h-full w-full bg-black" />
            )}
                {/* Safari places native controls at the center, top and bottom of the video. */}
                {draggable && !playing && !external && !error && (["left", "right"] as const).map(side => (
                    <div key={side} aria-hidden="true" data-video-drag-surface={side} className="absolute cursor-move"
                        style={{ [side]: 0, top: "max(32%, 44px)", bottom: "max(32%, 54px)", width: "min(15%, 48px)" }}
                        onDragStart={(event) => event.preventDefault()} />
                ))}
                {!error && (busy || buffering) && (
                    <div role="status" className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
                        <span className="rounded-full bg-black/75 px-3 py-1 text-xs text-white">视频缓冲中…</span>
                    </div>
                )}
                {error && (
                <div role="alert" className="absolute inset-x-2 top-2 rounded bg-black/80 p-2 text-xs text-white" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                    {error}{" "}
                    <button type="button" disabled={busy} onClick={() => void begin()} className="ml-2 underline">
                        {busy ? "重试中…" : "重试"}
                    </button>
                </div>
            )}
            </div>
            {showGenerationFooter && (generation?.mode === "draft" || generation?.mode === "final") ? (
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 bg-neutral-900 px-2 py-1.5 text-xs text-white" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                    <span>{generation.mode === "draft" ? "样片 · 480p" : "正式片 · 1080p"}</span>
                    {generation.mode === "draft" && context?.onGenerateFinal && mediaId ? (
                        <VideoFinalActionButton key={`${nodeId}:${mediaId}:${generation.taskId}`} nodeId={nodeId} mediaId={mediaId} source={generation} onGenerate={context.onGenerateFinal} label={context.finalActionLabel} />
                    ) : null}
                    {generation.mode === "draft" ? <span className="w-full text-[11px] text-neutral-400">{new Date(generation.createdAt).toLocaleDateString()} · 建议 3 天内转正式片</span> : null}
                </div>
            ) : null}
        </div>
    );
}

export function useExternalVideoNodes() {
    const [ids, setIds] = useState<Set<string>>(() => new Set());
    useEffect(() => {
        const update = () => {
            const next = new Set<string>();
            for (const element of [document.fullscreenElement, document.pictureInPictureElement]) {
                const video = element instanceof HTMLVideoElement ? element : element?.querySelector("video");
                if (video?.dataset.videoNodeId) next.add(video.dataset.videoNodeId);
            }
            setIds(next);
        };
        document.addEventListener("fullscreenchange", update);
        document.addEventListener("enterpictureinpicture", update, true);
        document.addEventListener("leavepictureinpicture", update, true);
        return () => {
            document.removeEventListener("fullscreenchange", update);
            document.removeEventListener("enterpictureinpicture", update, true);
            document.removeEventListener("leavepictureinpicture", update, true);
        };
    }, []);
    return ids;
}
