import type { ImageMask } from "@/types/image";

import { normalizeImageMask } from "./mask-utils";
import type { CanvasNodeData } from "../types";

export type CanvasMaskResources = Record<string, ImageMask>;

export type CanvasMaskMigration = {
    nodes: CanvasNodeData[];
    maskResources: CanvasMaskResources;
    changed: boolean;
};

export function resolveCanvasNodeMask(node: CanvasNodeData, resources?: CanvasMaskResources): ImageMask | undefined {
    const metadata = node.metadata;
    if (!metadata) return undefined;
    return normalizeImageMask((metadata.maskId && resources?.[metadata.maskId]) || metadata.imageMask || metadata.referenceMasks?.find(Boolean));
}

export function migrateCanvasMaskResources(nodes: CanvasNodeData[], existingResources?: CanvasMaskResources): CanvasMaskMigration {
    const maskResources = normalizeResources(existingResources);
    const idsBySignature = new Map<string, string>();
    Object.entries(maskResources).forEach(([id, mask]) => idsBySignature.set(maskSignature(mask), id));
    let changed = !sameResourceKeys(existingResources, maskResources);

    const migratedNodes = nodes.map((node) => {
        const metadata = node.metadata;
        if (!metadata) return node;
        const currentMaskId = metadata.maskId && maskResources[metadata.maskId] ? metadata.maskId : undefined;
        const mask = currentMaskId ? maskResources[currentMaskId] : resolveCanvasNodeMask(node, maskResources);
        let maskId = currentMaskId;

        if (mask && !maskId) {
            const signature = maskSignature(mask);
            maskId = idsBySignature.get(signature) || createMaskID(node.id, maskResources);
            if (!maskResources[maskId]) {
                maskResources[maskId] = mask;
                idsBySignature.set(signature, maskId);
            }
        }

        const nextMetadata = { ...metadata } as Record<string, unknown>;
        if (maskId) nextMetadata.maskId = maskId;
        else delete nextMetadata.maskId;
        if (!metadata.imageMask && Array.isArray(metadata.referenceMasks) && metadata.referenceMasks.some(Boolean) && typeof metadata.references?.[0] === "string" && !nextMetadata.sourceNodeId) {
            nextMetadata.sourceNodeId = metadata.references[0];
        }
        delete nextMetadata.imageMask;
        delete nextMetadata.referenceMasks;
        const metadataChanged = !sameMetadata(metadata, nextMetadata);
        if (metadataChanged) changed = true;
        return metadataChanged ? { ...node, metadata: nextMetadata as CanvasNodeData["metadata"] } : node;
    });

    const usedMaskIds = new Set(migratedNodes.flatMap((node) => (node.metadata?.maskId ? [node.metadata.maskId] : [])));
    Object.keys(maskResources).forEach((id) => {
        if (usedMaskIds.has(id)) return;
        delete maskResources[id];
        changed = true;
    });

    return { nodes: migratedNodes, maskResources, changed };
}

function normalizeResources(resources?: CanvasMaskResources): CanvasMaskResources {
    if (!resources) return {};
    return Object.fromEntries(
        Object.entries(resources).flatMap(([id, mask]) => {
            const normalized = normalizeImageMask(mask);
            return normalized ? [[id, normalized]] : [];
        }),
    );
}

function createMaskID(nodeId: string, resources: CanvasMaskResources) {
    const base = `mask-${nodeId}`;
    if (!resources[base]) return base;
    let index = 2;
    while (resources[`${base}-${index}`]) index += 1;
    return `${base}-${index}`;
}

function maskSignature(mask: ImageMask) {
    return JSON.stringify(mask);
}

function sameResourceKeys(source: CanvasMaskResources | undefined, normalized: CanvasMaskResources) {
    if (!source) return Object.keys(normalized).length === 0;
    const sourceKeys = Object.keys(source).sort();
    const normalizedKeys = Object.keys(normalized).sort();
    return sourceKeys.length === normalizedKeys.length && sourceKeys.every((id, index) => id === normalizedKeys[index] && source[id] === normalized[id]);
}

function sameMetadata(source: object, candidate: object) {
    const sourceEntries = Object.entries(source).sort(([left], [right]) => left.localeCompare(right));
    const candidateEntries = Object.entries(candidate).sort(([left], [right]) => left.localeCompare(right));
    return sourceEntries.length === candidateEntries.length && sourceEntries.every(([key, value], index) => key === candidateEntries[index]?.[0] && value === candidateEntries[index]?.[1]);
}
