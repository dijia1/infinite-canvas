import type { CanvasProjectDocument } from "./api/canvas-projects";

function isTransientCanvasUrl(value: string) {
    if (value.startsWith("blob:") || value.startsWith("data:")) return true;
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") return false;
        return Array.from(url.searchParams.keys()).some((key) => /^(x-amz-|x-oss-|x-goog-)|^(signature|sig|ossaccesskeyid|security-token|expires)$/i.test(key));
    } catch {
        return false;
    }
}

export function sanitizeCanvasProjectDocument(document: CanvasProjectDocument): CanvasProjectDocument {
    return {
        ...document,
        nodes: document.nodes.map((node) => {
            const content = node.metadata?.content;
            if (typeof content !== "string" || !isTransientCanvasUrl(content)) return node;
            const { content: _content, ...metadata } = node.metadata!;
            return { ...node, metadata };
        }),
        connections: [...document.connections],
        viewport: { ...document.viewport },
    };
}
