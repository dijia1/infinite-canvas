import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { uploadVideoMedia, getVideoMediaAccess } from "./video-media";

const originalDocument = globalThis.document;
const originalCreateURL = URL.createObjectURL;
const originalRevokeURL = URL.revokeObjectURL;
let metadataEvent: "loaded" | "error" | "pending";
let metadata: { duration: number; videoWidth: number; videoHeight: number };
let createdURLs: string[], revokedURLs: string[];
beforeEach(() => {
    metadataEvent = "loaded";
    metadata = { duration: 5, videoWidth: 1280, videoHeight: 720 };
    createdURLs = [];
    revokedURLs = [];
    URL.createObjectURL = () => {
        const url = `blob:video-${createdURLs.length}`;
        createdURLs.push(url);
        return url;
    };
    URL.revokeObjectURL = (url) => revokedURLs.push(url);
    globalThis.document = {
        createElement: () => {
            const video = {
                ...metadata,
                onloadedmetadata: null as (() => void) | null,
                onerror: null as (() => void) | null,
                removeAttribute() {},
                load() {},
                set src(_value: string) {
                    queueMicrotask(() => {
                        if (metadataEvent === "loaded") video.onloadedmetadata?.();
                        else if (metadataEvent === "error") video.onerror?.();
                    });
                },
            };
            return video;
        },
    } as unknown as Document;
});
afterEach(() => {
    if (originalDocument) globalThis.document = originalDocument;
    else Reflect.deleteProperty(globalThis, "document");
    URL.createObjectURL = originalCreateURL;
    URL.revokeObjectURL = originalRevokeURL;
    assert.deepEqual(revokedURLs, createdURLs);
});

test("video upload sends MP4 bytes directly to OSS and returns stable media", async () => {
    const originalPost = axios.post,
        originalFetch = globalThis.fetch;
    const events: string[] = [];
    const media = { mediaId: "video-media", url: "https://oss.example/video", duration: 5, contentType: "video/mp4", width: 1280, height: 720, bytes: 5 };
    axios.post = (async (url: string, body: unknown) => {
        events.push(url);
        if (url.endsWith("/complete")) assert.deepEqual(body, { duration: 5, width: 1280, height: 720 });
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
    axios.post = (async (url: string, body: unknown) => {
        if (url.endsWith("/complete")) {
            assert.deepEqual(body, { duration: 5, width: 1280, height: 720 });
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
        Object.defineProperty(file, "size", { value: 100 * 1024 * 1024 + 1 });
        await assert.rejects(uploadVideoMedia(file), /100 MB/);
        assert.equal(createdURLs.length, 0);
    } finally {
        axios.post = original;
    }
});

test("videos at 100 MB are uploaded directly without the old 50 MB restriction", async () => {
    const originalPost = axios.post,
        originalFetch = globalThis.fetch;
    const file = new File(["video"], "large.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: 100 * 1024 * 1024 });
    axios.post = (async (url: string, body: unknown) => {
        if (!url.endsWith("/complete")) assert.equal((body as { bytes: number }).bytes, file.size);
        return { data: { code: 0, data: url.endsWith("/complete") ? { mediaId: "large-video" } : { mode: "direct", id: "large", uploadUrl: "https://oss.example/upload" } } };
    }) as typeof axios.post;
    globalThis.fetch = (async (_url, init) => {
        assert.equal(init?.body, file);
        return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
        assert.equal((await uploadVideoMedia(file)).mediaId, "large-video");
    } finally {
        axios.post = originalPost;
        globalThis.fetch = originalFetch;
    }
});

test("unreadable video metadata fails locally without requesting an upload", async () => {
    const originalPost = axios.post;
    let requests = 0;
    axios.post = (async () => {
        requests++;
        throw Error("unexpected request");
    }) as typeof axios.post;
    try {
        const file = new File(["video"], "broken.mp4", { type: "video/mp4" });
        metadataEvent = "error";
        await assert.rejects(uploadVideoMedia(file), /无法读取视频/);
        metadataEvent = "loaded";
        metadata.duration = Infinity;
        await assert.rejects(uploadVideoMedia(file), /时长或尺寸/);
        assert.equal(requests, 0);
    } finally {
        axios.post = originalPost;
    }
});

test("cancelling local metadata reading releases its object URL", async () => {
    metadataEvent = "pending";
    const abort = new AbortController();
    const pending = uploadVideoMedia(new File(["video"], "v.mp4", { type: "video/mp4" }), { signal: abort.signal });
    abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
});
