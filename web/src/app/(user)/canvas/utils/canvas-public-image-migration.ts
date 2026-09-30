import { CanvasNodeType, type CanvasNodeData } from "../types";
import { imageStorageKeyForMedia } from "@/services/image-storage";

import { missingPublicImageMessage } from "@/services/canvas-image-hydration";

export type PublicImageReplacement = { nodeId: string; sourceMediaId: string; sourcePublicImageId: string; mediaId: string };

export function normalizePublicImageReferences(nodes: CanvasNodeData[], replacements: PublicImageReplacement[], missingNodeIds: string[]) {
    const missing = new Set(missingNodeIds);
    let changed = false;
    const result = nodes.map((node) => {
        if (node.type !== CanvasNodeType.Image) return node;
        const metadata = node.metadata || {};
        const replacement = replacements.find(
            (item) => (metadata.mediaId === item.sourceMediaId || (!metadata.mediaId && metadata.publicImageId === item.sourcePublicImageId)) && (!metadata.publicImageId || metadata.publicImageId === item.sourcePublicImageId),
        );
        if (replacement) {
            changed = true;
            const next = { ...metadata, mediaId: replacement.mediaId, storageKey: imageStorageKeyForMedia(replacement.mediaId), status: "success" as const };
            delete next.publicImageId;
            delete next.assetId;
            delete next.mediaExpiresAt;
            delete next.errorDetails;
            return { ...node, metadata: next };
        }
        if (missing.has(node.id) && (metadata.status !== "error" || metadata.errorDetails !== missingPublicImageMessage)) {
            changed = true;
            return { ...node, metadata: { ...metadata, content: undefined, status: "error" as const, errorDetails: missingPublicImageMessage } };
        }
        return node;
    });
    return changed ? result : nodes;
}

type MigrationIdentity = { scope: string | null; projectId: string; generation: number; revision: number; nodes: CanvasNodeData[] };
export function canApplyPublicImageMigration(expected: MigrationIdentity, current: MigrationIdentity & { blocked: boolean; dirty: boolean; pending: boolean }) {
    return (
        expected.scope === current.scope &&
        expected.projectId === current.projectId &&
        expected.generation === current.generation &&
        expected.revision === current.revision &&
        expected.nodes === current.nodes &&
        !current.blocked &&
        !current.dirty &&
        !current.pending
    );
}

export function hasPublicImageMigrationCandidates(nodes: CanvasNodeData[], canonicalNodes: CanvasNodeData[], initialScan: boolean) {
    // Only a restored server document needs the media-only legacy scan. Newly
    // inserted private images must not start a migration or interrupt imports.
    return nodes.some((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.publicImageId)) || (initialScan && canonicalNodes.some((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.mediaId)));
}
