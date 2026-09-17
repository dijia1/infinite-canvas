import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { CanvasNodeType } from "../types";

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

test("downloading a remote image preserves its reference without adding content to the node", async () => {
    const image = Object.freeze({
        id: "remote",
        type: CanvasNodeType.Image,
        metadata: Object.freeze({ mediaId: "media-1", mimeType: "image/webp" }),
    });
    const original = structuredClone(image);
    const saved: Array<[string, string]> = [];
    let finishAccess!: (url: string) => void;
    const access = new Promise<string>((resolve) => { finishAccess = resolve; });
    const download = callback("downloadNodeImage", {
        CanvasNodeType,
        loadMediaImage: async (id: string, resolve: () => Promise<string>) => {
            assert.equal(id, "media-1");
            assert.equal(await resolve(), "signed-original-url");
            return { url: "blob:original-image" };
        },
        resolveRemoteImage: (id: string) => {
            assert.equal(id, "media-1");
            return access;
        },
        saveAs: (url: string, filename: string) => saved.push([url, filename]),
        imageExtension: (mimeType: string) => {
            assert.equal(mimeType, "image/webp");
            return "webp";
        },
    });
    const pending = download(image);
    assert.deepEqual(saved, []);
    assert.deepEqual(image, original);
    finishAccess("signed-original-url");
    await pending;
    assert.deepEqual(saved, [["blob:original-image", "canvas-image-remote.webp"]]);
    assert.deepEqual(image, original);
    assert.equal("content" in image.metadata, false);
});

test("downloads resolve remote and public references and propagate access failures", async () => {
    const saved: string[] = [];
    const download = callback("downloadNodeImage", {
        CanvasNodeType,
        resolveStoredImageReference: async () => "",
        loadMediaImage: async (_id: string, resolve: () => Promise<string>) => ({ url: await resolve() }),
        resolveRemoteImage: async (id: string) => {
            if (id === "missing") throw new Error("not found");
            return "remote-url";
        },
        fetchPublicImageAccess: async () => ({ url: "public-url" }),
        saveAs: (url: string) => saved.push(url),
        imageExtension: () => "png",
    });
    await download({ id: "one", type: CanvasNodeType.Image, metadata: { mediaId: "one" } });
    await download({ id: "two", type: CanvasNodeType.Image, metadata: { publicImageId: "two" } });
    assert.deepEqual(saved, ["remote-url", "public-url"]);
    await assert.rejects(download({ id: "missing", type: CanvasNodeType.Image, metadata: { mediaId: "missing" } }), /not found/);
    assert.equal(saved.length, 2);
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
