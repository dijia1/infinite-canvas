"use client";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createVideoResourceManager, type VideoResourceLease, type VideoResourceManager } from "../media/video-resource-manager";
import { useCanvasStore } from "../stores/use-canvas-store";

type Playback = { time: number; volume: number; muted: boolean; rate: number };
type Resources = { manager: VideoResourceManager; playback: Map<string, Playback> };
const Context = createContext<Resources | null>(null);
export function VideoResourceProvider({ projectId, nodeIds, children }: { projectId: string; nodeIds: string[]; children: ReactNode }) {
    const scope = useCanvasStore((s) => s.syncScope);
    return <ScopedVideoResourceProvider scope={`${scope}:${projectId}`} nodeIds={nodeIds} resetOnCanvasScopeChange>{children}</ScopedVideoResourceProvider>;
}

export function ScopedVideoResourceProvider({ scope, nodeIds, children, resetOnCanvasScopeChange = false }: { scope: string; nodeIds: string[]; children: ReactNode; resetOnCanvasScopeChange?: boolean }) {
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
    return <Context.Provider value={resources}>{children}</Context.Provider>;
}

export function CanvasVideoContent({ nodeId, mediaId, legacyURL, visible = true }: { nodeId: string; mediaId?: string; legacyURL?: string; visible?: boolean }) {
    const resources = useContext(Context);
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
    const save = () => {
        const video = videoRef.current;
        if (video && video.readyState > 0 && resources && Number.isFinite(video.currentTime)) resources.playback.set(nodeId, { time: video.currentTime, volume: video.volume, muted: video.muted, rate: video.playbackRate });
    };
    useLayoutEffect(() => {
        setSource(undefined);
        setPoster(undefined);
        setBusy(false);
        setError("");
        recovering.current = false;
        failed.current = false;
        setPlaying(false);
        attempt.current++;
        snapshot.current = resources?.playback.get(nodeId);
        return () => {
            attempt.current++;
            clearTimeout(recoveryTimer.current);
        };
    }, [resources, mediaId, nodeId]);
    useEffect(() => {
        if (!resources || !mediaId || (!visible && !source && !external)) return;
        const lease = resources.manager.acquire(mediaId);
        leaseRef.current = lease;
        let live = true;
        if (visible && !source)
            void lease
                .getAccess()
                .then((value) => {
                    if (live) setSource(value.url);
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
    useEffect(() => {
        if (source && switching.current) videoRef.current?.load();
    }, [source]);
    useEffect(() => {
        if (visible || external) return;
        wantsPlay.current = false;
        videoRef.current?.pause();
        save();
        const timer = setTimeout(() => {
            save();
            setSource(undefined);
        }, 10000);
        return () => clearTimeout(timer);
    }, [visible, external, source]);
    useLayoutEffect(
        () => () => {
            save();
            videoRef.current?.pause();
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
                wantsPlay.current = false;
            });
    };
    const loaded = () => {
        const video = videoRef.current;
        if (!video || failed.current) return;
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
        <div className="relative h-full w-full overflow-hidden rounded-[18px] bg-black">
            {visible || source ? (
                <video
                    ref={videoRef}
                    data-video-node-id={nodeId}
                    src={source}
                    controls
                    poster={poster}
                    preload={legacyURL?.startsWith("blob:") ? "metadata" : "none"}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    playsInline
                    className="h-full w-full object-contain"
                    onLoadedMetadata={loaded}
                    onSeeked={resume}
                    onError={() => void playbackError()}
                    onPlay={() => {
                        wantsPlay.current = true;
                        setPlaying(true);
                        if (!switching.current && videoRef.current?.readyState === 0) {
                            clearTimeout(recoveryTimer.current);
                            recoveryTimer.current = setTimeout(() => fail("视频加载超时，点击重试"), 20000);
                        }
                    }}
                    onPause={() => {
                        setPlaying(false);
                        if (!switching.current && !videoRef.current?.error) wantsPlay.current = false;
                        save();
                    }}
                    onEnded={() => {
                        wantsPlay.current = false;
                        save();
                    }}
                    onTimeUpdate={save}
                />
            ) : poster ? (
                <img src={poster} alt="视频封面" className="h-full w-full object-contain" onError={() => setPoster(undefined)} />
            ) : (
                <div className="h-full w-full bg-black" />
            )}
            {!playing && !external && !error && <div aria-hidden="true" data-video-drag-surface className="absolute inset-x-0 top-0 cursor-move" style={{ bottom: 54 }} onDragStart={(event) => event.preventDefault()} />}
            {error && (
                <div role="alert" className="absolute inset-x-2 top-2 rounded bg-black/80 p-2 text-xs text-white" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                    {error}{" "}
                    <button type="button" disabled={busy} onClick={() => void begin()} className="ml-2 underline">
                        {busy ? "重试中…" : "重试"}
                    </button>
                </div>
            )}
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
