import { useCallback } from "react";

import { loadMediaImage, loadMediaThumbnail } from "@/services/image-storage";

import { useVisibleMediaPreview } from "./use-visible-media-preview";

type MaterialMediaAccess = {
    url: string;
    previewUrl?: string;
};

type MaterialMediaPreviewOptions = {
    identity: string;
    mediaId: string;
    enabled: boolean;
    fallback?: string;
    loadAccess: () => Promise<MaterialMediaAccess>;
};

export function useMaterialMediaPreview({ identity, mediaId, enabled, fallback, loadAccess }: MaterialMediaPreviewOptions) {
    const loadPreview = useCallback(
        () => loadMediaThumbnail(mediaId, async () => {
            const access = await loadAccess();
            return access.previewUrl || access.url;
        }),
        [loadAccess, mediaId],
    );
    const visible = useVisibleMediaPreview({ identity, enabled, fallback, load: loadPreview });
    const loadOriginal = useCallback(
        () => loadMediaImage(mediaId, async () => (await loadAccess()).url),
        [loadAccess, mediaId],
    );
    return { ...visible, loadOriginal };
}
