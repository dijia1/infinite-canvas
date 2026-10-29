import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { CanvasNodeType } from "../types";
import { canvasImageDownloadTargets } from "../utils/canvas-download-utils";

function callback(name: string, dependencies: Record<string, unknown>) {
    const source = ts.createSourceFile("canvas.tsx", readFileSync(new URL("./canvas-client-page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let expression: ts.Node | undefined;
    function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0];
        ts.forEachChild(node, visit);
    }
    visit(source);
    assert.ok(expression);
    const js = ts.transpileModule("const callback = " + expression.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(dependencies), js + ";return callback;")(...Object.values(dependencies));
}

test("downloading a remote image queues its stable reference without changing the node", async () => {
    const image = Object.freeze({ id: "remote", type: CanvasNodeType.Image, title: "", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: Object.freeze({ mediaId: "media-1", mimeType: "image/webp" }) });
    const original = structuredClone(image);
    const queued: unknown[] = [];
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const download = callback("downloadNodeImage", {
        CanvasNodeType, canvasImageDownloadTargets,
        imageDownloads: { queue: { start: async (targets: unknown) => { queued.push(targets); await gate; } } },
    });
    const pending = download(image);
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0], canvasImageDownloadTargets([image]));
    assert.deepEqual(image, original);
    finish(); await pending;
    assert.deepEqual(image, original);
    assert.equal("content" in image.metadata, false);
});

test("multi-selection uses the same queue and snapshots references without starting per-image saves", async () => {
    const nodes = [{ id: "one", type: CanvasNodeType.Image, title: "", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { mediaId: "media-1" } }];
    const queued: unknown[] = [];
    const download = callback("downloadSelectedImages", { canvasImageDownloadTargets, imageDownloads: { queue: { start: async (targets: unknown) => { queued.push(targets); return true; } } } });
    await download(nodes);
    const expected = structuredClone(queued);
    nodes[0]!.metadata.mediaId = "new-media";
    assert.deepEqual(queued, expected);
});

test("video download resolves stable media, prevents duplicate clicks and releases failed requests", async () => {
    const requests: unknown[][] = [];
    const messages: string[] = [];
    const videoDownloads = { current: new Set<string>() };
    let finish: (() => void) | undefined;
    const download = callback("downloadNodeImage", {
        CanvasNodeType,
        videoDownloads,
        message: { success: (text: string) => messages.push(text) },
        downloadVideo: async (id: string, content: unknown, filename: string) => {
            requests.push([id, content, filename]);
            if (id === "missing") throw new Error("视频不可访问");
            await new Promise<void>((resolve) => { finish = resolve; });
        },
    });
    const node = { id: "video", type: CanvasNodeType.Video, metadata: { mediaId: "video-media" } };
    const pending = download(node);
    await download(node);
    assert.deepEqual(requests, [["video-media", undefined, "canvas-video-video.mp4"]]);
    assert.equal(messages.length, 0);
    assert.ok(finish);
    finish();
    await pending;
    assert.deepEqual(messages, ["已发起下载"]);
    assert.equal(videoDownloads.current.size, 0);
    assert.equal("content" in node.metadata, false);
    for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(download({ ...node, metadata: { mediaId: "missing" } }), /不可访问/);
        assert.equal(videoDownloads.current.size, 0);
    }
    assert.equal(requests.length, 3);
    assert.equal(messages.length, 1);
});
