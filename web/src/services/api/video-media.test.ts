import { test } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { uploadVideoMedia, getVideoMediaAccess } from "./video-media";

test("video upload sends MP4 bytes directly to OSS and returns stable media", async () => {
    const originalPost = axios.post,
        originalFetch = globalThis.fetch;
    const events: string[] = [];
    const media = { mediaId: "video-media", url: "https://oss.example/video", duration: 5, contentType: "video/mp4", width: 1280, height: 720, bytes: 5 };
    axios.post = (async (url: string) => {
        events.push(url);
        return { data: { code: 0, data: url.endsWith("/complete") ? media : { mode: "direct", id: "upload", uploadUrl: "https://oss.example/upload" } } };
    }) as typeof axios.post;
    const file = new File(["video"], "reference.mp4", { type: "video/mp4" });
    globalThis.fetch = (async (url, init) => {
        events.push(String(url));
        assert.equal(init?.method, "PUT");
        assert.equal(init?.body, file);
        return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
        assert.deepEqual(await uploadVideoMedia(file), media);
        assert.equal(events.length, 3);
        assert.equal(events[1], "https://oss.example/upload");
    } finally {
        axios.post = originalPost;
        globalThis.fetch = originalFetch;
    }
});

test("video OSS failure does not finalize and next upload is independent", async () => {
    const originalPost = axios.post,
        originalFetch = globalThis.fetch;
    let completed = 0,
        succeeds = false;
    axios.post = (async (url: string) => {
        if (url.endsWith("/complete")) completed++;
        return { data: { code: 0, data: url.endsWith("/complete") ? { mediaId: "next" } : { mode: "direct", id: "upload", uploadUrl: "https://oss.example/upload" } } };
    }) as typeof axios.post;
    globalThis.fetch = (async () => new Response(null, { status: succeeds ? 200 : 500 })) as typeof fetch;
    try {
        const file = new File(["video"], "ref.mp4", { type: "video/mp4" });
        await assert.rejects(uploadVideoMedia(file), /上传失败/);
        assert.equal(completed, 0);
        succeeds = true;
        assert.equal((await uploadVideoMedia(file)).mediaId, "next");
        assert.equal(completed, 1);
        await assert.rejects(uploadVideoMedia(new Blob(["text"], { type: "text/plain" })), /MP4/);
    } finally {
        axios.post = originalPost;
        globalThis.fetch = originalFetch;
    }
});

test("video access forwards cancellation and rejects failed API envelope", async () => {
    const original = axios.get;
    const abort = new AbortController();
    axios.get = (async (_url, config) => {
        assert.equal(config?.signal, abort.signal);
        return { data: { code: 1, msg: "不可访问" } };
    }) as typeof axios.get;
    try {
        await assert.rejects(getVideoMediaAccess("other-user", abort.signal), /不可访问/);
    } finally {
        axios.get = original;
    }
});

test("video upload reports progress and retries confirmation without reupload", async () => {
    const originalPost = axios.post,
        originalXHR = globalThis.XMLHttpRequest;
    const stages: string[] = [],
        progress: number[] = [];
    let puts = 0,
        intents = 0,
        completes = 0,
        uploadedIntent = "";
    class UploadXHR {
        upload = { onprogress: undefined as undefined | ((event: object) => void) };
        status = 200;
        onload?: () => void;
        open() {}
        setRequestHeader() {}
        send() {
            puts++;
            this.upload.onprogress?.({ lengthComputable: true, total: 100, loaded: 37 });
            this.onload?.();
        }
        abort() {}
    }
    globalThis.XMLHttpRequest = UploadXHR as unknown as typeof XMLHttpRequest;
    axios.post = (async (url: string) => {
        if (url.endsWith("/complete")) {
            completes++;
            if (completes === 1) throw new Error("confirmation interrupted");
            return { data: { code: 0, data: { mediaId: "confirmed" } } };
        }
        intents++;
        return { data: { code: 0, data: { mode: "direct", id: "uploaded-once", uploadUrl: "https://oss.example/upload" } } };
    }) as typeof axios.post;
    try {
        const file = new File(["video"], "v.mp4", { type: "video/mp4" });
        await assert.rejects(uploadVideoMedia(file, { onProgress: (p) => progress.push(p), onStage: (s) => stages.push(s), onUploaded: (id) => (uploadedIntent = id) }), /confirmation interrupted/);
        assert.equal(uploadedIntent, "uploaded-once");
        assert.deepEqual(progress, [37]);
        assert.deepEqual(stages, ["uploading", "verifying"]);
        assert.equal((await uploadVideoMedia(file, { uploadedIntentId: uploadedIntent })).mediaId, "confirmed");
        assert.equal(puts, 1);
        assert.equal(intents, 1);
        assert.equal(completes, 2);
    } finally {
        axios.post = originalPost;
        globalThis.XMLHttpRequest = originalXHR;
    }
});

test("oversized video is rejected before requesting an upload", async () => {
    const original = axios.post;
    axios.post = (async () => {
        throw Error("unexpected request");
    }) as typeof axios.post;
    try {
        const file = new File(["x"], "large.mp4", { type: "video/mp4" });
        Object.defineProperty(file, "size", { value: 100 * 1024 * 1024 });
        await assert.rejects(uploadVideoMedia(file), /50 MB/);
    } finally {
        axios.post = original;
    }
});
