import assert from "node:assert/strict";
import test from "node:test";

import type { CanvasProjectDocument } from "./api/canvas-projects";
import { sanitizeCanvasProjectDocument } from "./canvas-project-document.ts";

test("removes transient image content without mutating the local preview document", () => {
    const document = {
        nodes: [
            { id: "blob", metadata: { mediaId: "m1", content: "blob:local" } },
            { id: "data", metadata: { storageKey: "image:legacy", content: "data:image/png;base64,abc" } },
            { id: "signed", metadata: { mediaId: "m2", content: "https://cdn.example/image?X-Amz-Signature=secret&Expires=1" } },
            { id: "stable", metadata: { content: "https://cdn.example/public.png" } },
        ],
        connections: [],
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
    } as unknown as CanvasProjectDocument;

    const sanitized = sanitizeCanvasProjectDocument(document);

    assert.equal(sanitized.nodes[0]?.metadata?.content, undefined);
    assert.equal(sanitized.nodes[1]?.metadata?.content, undefined);
    assert.equal(sanitized.nodes[2]?.metadata?.content, undefined);
    assert.equal(sanitized.nodes[3]?.metadata?.content, "https://cdn.example/public.png");
    assert.equal(document.nodes[0]?.metadata?.content, "blob:local");
});
