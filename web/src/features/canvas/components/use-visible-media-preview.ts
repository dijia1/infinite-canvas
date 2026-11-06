"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import { releaseImageObjectURL, type UploadedImage } from "@/services/image-storage";

const PREFETCH_MARGIN = "400px";
const MAX_CONCURRENT_PREVIEW_LOADS = 4;

let activePreviewLoads = 0;
const previewLoadQueue: Array<() => void> = [];

function schedulePreviewLoad<T>(load: () => Promise<T>) {
    return new Promise<T>((resolve, reject) => {
        const start = () => {
            activePreviewLoads += 1;
            void load().then(resolve, reject).finally(() => {
                activePreviewLoads -= 1;
                previewLoadQueue.shift()?.();
            });
        };
        if (activePreviewLoads < MAX_CONCURRENT_PREVIEW_LOADS) start();
        else previewLoadQueue.push(start);
    });
}

export function useVisibleMediaPreview({
    identity,
    enabled,
    fallback = "",
    load,
}: {
    identity: string;
    enabled: boolean;
    fallback?: string;
    load: () => Promise<UploadedImage>;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const storageKeyRef = useRef<string | undefined>(undefined);
    const [isNearViewport, setIsNearViewport] = useState(false);
    const [url, setURL] = useState(() => (enabled ? "" : fallback));
    const [error, setError] = useState<unknown>();
    const [loading, setLoading] = useState(enabled);

    useEffect(() => {
        const target = ref.current;
        if (!target) return;
        if (typeof IntersectionObserver === "undefined") {
            setIsNearViewport(true);
            return;
        }
        const observer = new IntersectionObserver(
            ([entry]) => setIsNearViewport(entry.isIntersecting),
            { rootMargin: PREFETCH_MARGIN },
        );
        observer.observe(target);
        return () => observer.disconnect();
    }, [identity]);

    useEffect(() => {
        if (!enabled) {
            setURL(fallback);
            setError(undefined);
            setLoading(false);
            return;
        }
        if (!isNearViewport) {
            if (storageKeyRef.current) {
                releaseImageObjectURL(storageKeyRef.current);
                storageKeyRef.current = undefined;
            }
            setURL("");
            setError(undefined);
            setLoading(true);
            return;
        }

        let cancelled = false;
        setLoading(true);
        void schedulePreviewLoad(load)
            .then((image) => {
                if (cancelled) {
                    releaseImageObjectURL(image.storageKey);
                    return;
                }
                storageKeyRef.current = image.storageKey;
                setURL(image.url || fallback);
                setError(undefined);
            })
            .catch((loadError) => {
                if (!cancelled) {
                    setURL(fallback);
                    setError(loadError);
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [enabled, fallback, identity, isNearViewport, load]);

    useEffect(() => {
        return () => {
            if (storageKeyRef.current) releaseImageObjectURL(storageKeyRef.current);
        };
    }, []);

    return { ref: ref as RefObject<HTMLDivElement>, url, error, loading };
}
