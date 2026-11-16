"use client";

import type { ReactNode } from "react";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasNodeData } from "../types";
import { generatedVideoDetails, isGeneratedVideoResult } from "../utils/canvas-generated-result";
import { CanvasNodeResultPanel } from "./canvas-node-result-panel";
import { CanvasVideoFinalAction, useVideoGenerationSource } from "./canvas-video-content";

export function CanvasVideoResultPanel({ node, models, theme, fallback }: { node: CanvasNodeData; models?: readonly { id: string; name: string }[]; theme: CanvasTheme; fallback?: ReactNode }) {
    const recorded = isGeneratedVideoResult(node);
    // Library inserts intentionally do not copy canvas generation markers. Use
    // media provenance to retain their draft action without changing saved data.
    const { generation, error, retry } = useVideoGenerationSource(recorded ? undefined : node.metadata?.mediaId);
    if (!recorded && generation?.mode !== "draft" && generation?.mode !== "final") return <>
        {fallback}
        {error ? <div role="alert" className="mt-2 text-xs text-red-500">{error}{" "}<button type="button" className="underline" onClick={retry}>重试</button></div> : null}
    </>;
    const metadata = !recorded && generation ? {
        ...node.metadata,
        videoProviderId: generation.providerId,
        vquality: generation.mode === "draft" ? "480p" : "1080p",
        videoSize: generation.size,
        seconds: String(generation.seconds),
    } : node.metadata;
    return <CanvasNodeResultPanel details={generatedVideoDetails(metadata, models)} theme={theme} mediaType="video" actions={node.metadata?.mediaId ? <CanvasVideoFinalAction nodeId={node.id} mediaId={node.metadata.mediaId} theme={theme} /> : undefined} />;
}
