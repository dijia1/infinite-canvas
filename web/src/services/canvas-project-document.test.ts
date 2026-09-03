import assert from "node:assert/strict";
import test from "node:test";

import type { CanvasProjectDocument } from "./api/canvas-projects";
import { sanitizeCanvasProjectDocument } from "./canvas-project-document.ts";

test("removes only media preview fields without mutating text or config content", () => {
    const document = {
        nodes: [
            {
                id: "blob",
                type: "image",
                metadata: {
                    mediaId: "m1",
                    content: "blob:local",
                    url: "blob:direct",
                    previewUrl: "data:image/png;base64,preview",
                    thumbnailUrl: "https://cdn.example/thumb?sig=secret",
                    coverUrl: "https://cdn.example/stable-cover.png",
                    references: ["image:stable", "blob:reference", "data:image/png;base64,reference", "https://cdn.example/ref?Expires=1", "https://cdn.example/stable-reference.png"],
                    access: { url: "https://cdn.example/image?X-Amz-Signature=secret", mediaId: "m1" },
                },
            },
            { id: "data", type: "video", metadata: { storageKey: "video:legacy", content: "data:video/mp4;base64,abc" } },
            { id: "signed", type: "image", metadata: { mediaId: "m2", content: "https://cdn.example/image?X-Amz-Signature=secret&Expires=1" } },
            { id: "stable", type: "image", metadata: { content: "https://cdn.example/public.png" } },
            { id: "text", type: "text", metadata: { content: "https://example.test/copy?X-Amz-Signature=words" } },
            { id: "config", type: "config", metadata: { content: "data:image/png;base64,used-as-config-text" } },
        ],
        connections: [],
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        notes: "data:image/png;base64,used-as-document-text",
    } as unknown as CanvasProjectDocument;

    const sanitized = sanitizeCanvasProjectDocument(document);

    assert.equal(sanitized.nodes[0]?.metadata?.content, undefined);
    assert.equal(sanitized.nodes[1]?.metadata?.content, undefined);
    assert.equal(sanitized.nodes[2]?.metadata?.content, undefined);
    assert.equal(sanitized.nodes[3]?.metadata?.content, "https://cdn.example/public.png");
    assert.equal(sanitized.nodes[4]?.metadata?.content, "https://example.test/copy?X-Amz-Signature=words");
    assert.equal(sanitized.nodes[5]?.metadata?.content, "data:image/png;base64,used-as-config-text");
    assert.deepEqual((sanitized.nodes[0]?.metadata as Record<string, unknown>).access, { mediaId: "m1" });
    assert.equal((sanitized.nodes[0]?.metadata as Record<string, unknown>).url, undefined);
    assert.equal((sanitized.nodes[0]?.metadata as Record<string, unknown>).previewUrl, undefined);
    assert.equal((sanitized.nodes[0]?.metadata as Record<string, unknown>).thumbnailUrl, undefined);
    assert.equal((sanitized.nodes[0]?.metadata as Record<string, unknown>).coverUrl, "https://cdn.example/stable-cover.png");
    assert.deepEqual((sanitized.nodes[0]?.metadata as Record<string, unknown>).references, ["image:stable", "https://cdn.example/stable-reference.png"]);
    assert.equal((sanitized as unknown as { notes: string }).notes, "data:image/png;base64,used-as-document-text");
    assert.equal(document.nodes[0]?.metadata?.content, "blob:local");
    assert.equal(((document.nodes[0]?.metadata as Record<string, unknown>).access as { url: string }).url, "https://cdn.example/image?X-Amz-Signature=secret");
});

test("migrates repeated legacy mask strokes into one document-level mask resource", () => {
    const mask = { version: 1 as const, strokes: [{ id: "stroke", tool: "paint" as const, radius: 0.1, points: [{ x: 0.5, y: 0.5 }] }] };
    const document = {
        nodes: [
            { id: "source", type: "image", title: "source", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { mediaId: "media-source", imageMask: mask } },
            { id: "result-a", type: "image", title: "result-a", position: { x: 400, y: 0 }, width: 320, height: 240, metadata: { generationType: "edit", references: ["media:media-source:v1:original"], referenceMasks: [mask] } },
            { id: "result-b", type: "image", title: "result-b", position: { x: 800, y: 0 }, width: 320, height: 240, metadata: { generationType: "edit", references: ["media:media-source:v1:original"], referenceMasks: [mask] } },
        ],
        connections: [],
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
    } as unknown as CanvasProjectDocument;

    const sanitized = sanitizeCanvasProjectDocument(document);
    const resources = (sanitized as CanvasProjectDocument & { maskResources?: Record<string, unknown> }).maskResources;
    const sourceMaskID = sanitized.nodes[0]?.metadata?.maskId;

    assert.ok(resources);
    assert.equal(Object.keys(resources!).length, 1);
    assert.ok(sourceMaskID);
    assert.equal(sanitized.nodes[1]?.metadata?.maskId, sourceMaskID);
    assert.equal(sanitized.nodes[2]?.metadata?.maskId, sourceMaskID);
    assert.equal("imageMask" in (sanitized.nodes[0]?.metadata || {}), false);
    assert.equal("referenceMasks" in (sanitized.nodes[1]?.metadata || {}), false);
});
