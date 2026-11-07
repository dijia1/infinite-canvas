import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sourceModule } from "@/test-utils/source-component";
import type { MaterialVideoCard } from "./material-video-card";

for (const previewUrl of ["https://example.invalid/first-frame.jpg", undefined]) {
    test(`video grid ${previewUrl ? "loads the poster" : "never falls back to downloading the video"}`, async () => {
        let loadAccess!: () => Promise<{ previewUrl?: string }>;
        const { MaterialVideoCard: Card } = sourceModule<{ MaterialVideoCard: typeof MaterialVideoCard }>(new URL("./material-video-card.tsx", import.meta.url), {
            react: React,
            "lucide-react": { Play: () => null, RefreshCw: () => null, Video: () => null },
            "@/services/api/video-media": { getVideoMediaAccess: async () => ({ url: "https://example.invalid/movie.mp4", previewUrl }) },
            "./material-image-drag": { PRIVATE_VIDEO_DRAG_TYPE: "private-video" },
            "./use-material-media-preview": { useMaterialMediaPreview: (options: { loadAccess: typeof loadAccess }) => { loadAccess = options.loadAccess; return { loading: false }; } },
        });
        const html = renderToStaticMarkup(<Card asset={{ id: "video", kind: "video", title: "视频", coverUrl: "", tags: [], data: { url: "", width: 0, height: 0, bytes: 1000, mimeType: "video/mp4" }, metadata: { mediaId: "video" }, createdAt: "", updatedAt: "" }} onPreview={() => undefined} onContextMenu={() => undefined} />);
        assert.doesNotMatch(html, /<video|movie\.mp4/);
        assert.match(html, /draggable="true"/);
        if (previewUrl) assert.equal((await loadAccess()).previewUrl, previewUrl);
        else await assert.rejects(loadAccess(), /封面暂不可用/);
    });
}
