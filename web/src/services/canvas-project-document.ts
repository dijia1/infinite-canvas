import type { CanvasProjectDocument } from "./api/canvas-projects";

function isTransientCanvasUrl(value: string) {
    const normalized = value.trim();
    if (/^(blob|data):/i.test(normalized)) return true;
    try {
        const url = new URL(normalized);
        if (url.protocol !== "http:" && url.protocol !== "https:") return false;
        return Array.from(url.searchParams.keys()).some((key) => /^(x-amz-|x-oss-|x-goog-)|^(signature|sig|ossaccesskeyid|security-token|expires)$/i.test(key));
    } catch {
        return false;
    }
}

function sanitizeMediaAccess(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const access = value as Record<string, unknown>;
    const sanitized = Object.fromEntries(Object.entries(access).filter(([, field]) => typeof field !== "string" || !isTransientCanvasUrl(field)));
    return Object.keys(sanitized).length === Object.keys(access).length ? value : sanitized;
}

const mediaPreviewFields = ["content", "url", "previewUrl", "thumbnailUrl", "coverUrl"] as const;

function sanitizeMediaMetadata(value: Record<string, unknown>) {
    let sanitized: Record<string, unknown> | null = null;
    const update = () => (sanitized ||= { ...value });

    for (const key of mediaPreviewFields) {
        if (typeof value[key] === "string" && isTransientCanvasUrl(value[key])) delete update()[key];
    }

    const access = sanitizeMediaAccess(value.access);
    if (access !== value.access) update().access = access;

    const references = value.references;
    if (Array.isArray(references)) {
        const retainedIndexes = references.flatMap((reference, index) => (typeof reference === "string" && isTransientCanvasUrl(reference) ? [] : [index]));
        if (retainedIndexes.length !== references.length) {
            update().references = retainedIndexes.map((index) => references[index]);
            const referenceMasks = value.referenceMasks;
            if (Array.isArray(referenceMasks)) update().referenceMasks = retainedIndexes.map((index) => referenceMasks[index]);
        }
    }
    return sanitized || value;
}

export function sanitizeCanvasProjectDocument(document: CanvasProjectDocument): CanvasProjectDocument {
    return {
        ...document,
        nodes: document.nodes.map((node) => {
            if (node.type !== "image" && node.type !== "video") return node;
            const metadata = node.metadata as Record<string, unknown> | undefined;
            if (!metadata) return node;
            const sanitized = sanitizeMediaMetadata(metadata);
            return sanitized === metadata ? node : { ...node, metadata: sanitized as NonNullable<typeof node.metadata> };
        }),
        connections: [...document.connections],
        viewport: { ...document.viewport },
    };
}
