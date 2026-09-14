import assert from "node:assert/strict";
import test from "node:test";

import axios from "axios";

import { getImageGenerationTask, ImageRequestRejectedError, requestGeneration, uploadUserImage } from "./image";

type AxiosPost = typeof axios.post;

function withAxiosPost(handler: AxiosPost) {
    const original = axios.post;
    axios.post = handler;
    return () => {
        axios.post = original;
    };
}

test("uploads directly to OSS then confirms a user image", async () => {
    const calls: string[] = [];
    const restorePost = withAxiosPost((async (url: string) => {
        calls.push(url);
        if (url.endsWith("/media/upload-intents")) {
            return { data: { code: 0, data: { mode: "direct", id: "intent-1", uploadUrl: "https://oss.example/upload", expiresAt: "2026-09-04T00:15:00Z" } } };
        }
        if (url.endsWith("/media/upload-intents/intent-1/complete")) {
            return { data: { code: 0, data: { mediaId: "media-1", url: "https://oss.example/read", mediaExpiresAt: "2026-09-04T01:00:00Z" } } };
        }
        throw new Error(`unexpected request ${url}`);
    }) as AxiosPost);
    const originalFetch = globalThis.fetch;
    let put: Request | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        put = new Request(input, init);
        return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
        const result = await uploadUserImage(new File(["image"], "sample.png", { type: "image/png" }));
        assert.deepEqual(result, { mediaId: "media-1", url: "https://oss.example/read", mediaExpiresAt: "2026-09-04T01:00:00Z" });
        assert.deepEqual(calls.map((url) => url.replace(/^.*\/api\/v1/, "/api/v1")), ["/api/v1/media/upload-intents", "/api/v1/media/upload-intents/intent-1/complete"]);
        assert.equal(put?.method, "PUT");
        assert.equal(put?.headers.get("Content-Type"), "image/png");
    } finally {
        restorePost();
        globalThis.fetch = originalFetch;
    }
});

test("does not confirm an OSS upload after PUT fails", async () => {
    const calls: string[] = [];
    const restorePost = withAxiosPost((async (url: string) => {
        calls.push(url);
        return { data: { code: 0, data: { mode: "direct", id: "intent-1", uploadUrl: "https://oss.example/upload" } } };
    }) as AxiosPost);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 403, statusText: "Forbidden" })) as typeof fetch;
    try {
        await assert.rejects(uploadUserImage(new File(["image"], "sample.png", { type: "image/png" })), /上传/);
        assert.equal(calls.length, 1);
    } finally {
        restorePost();
        globalThis.fetch = originalFetch;
    }
});

test("reports direct OSS upload progress before confirming the media", async () => {
    const restorePost = withAxiosPost((async (url: string) => {
        if (url.endsWith("/media/upload-intents")) {
            return { data: { code: 0, data: { mode: "direct", id: "intent-1", uploadUrl: "https://oss.example/upload" } } };
        }
        if (url.endsWith("/media/upload-intents/intent-1/complete")) {
            return { data: { code: 0, data: { mediaId: "media-1", url: "https://oss.example/read" } } };
        }
        throw new Error(`unexpected request ${url}`);
    }) as AxiosPost);
    const originalXMLHttpRequest = globalThis.XMLHttpRequest;
    const progress: number[] = [];

    class ProgressXMLHttpRequest {
        status = 200;
        upload: { onprogress?: (event: ProgressEvent<EventTarget>) => void } = {};
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onabort: (() => void) | null = null;
        open() {}
        setRequestHeader() {}
        send() {
            this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent<EventTarget>);
            this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 } as ProgressEvent<EventTarget>);
            this.onload?.();
        }
        abort() {
            this.onabort?.();
        }
    }

    globalThis.XMLHttpRequest = ProgressXMLHttpRequest as unknown as typeof XMLHttpRequest;
    try {
        const result = await uploadUserImage(new File(["image"], "sample.png", { type: "image/png" }), "library", { onProgress: (value) => progress.push(value) });
        assert.equal(result.mediaId, "media-1");
        assert.deepEqual(progress, [50, 100]);
    } finally {
        restorePost();
        globalThis.XMLHttpRequest = originalXMLHttpRequest;
    }
});

test("keeps the multipart upload fallback for local storage and reports progress", async () => {
	let body: unknown;
	const progress: number[] = [];
	const restorePost = withAxiosPost((async (url: string, input: unknown, config?: { onUploadProgress?: (event: { loaded?: number; total?: number }) => void }) => {
		if (url.endsWith("/media/upload-intents")) {
			return { data: { code: 0, data: { mode: "proxy" } } };
		}
		body = input;
		config?.onUploadProgress?.({ loaded: 25, total: 100 });
		return { data: { code: 0, data: { mediaId: "media-1", url: "/api/v1/media/media-1/content" } } };
	}) as AxiosPost);
    try {
        const result = await uploadUserImage(new File(["image"], "sample.png", { type: "image/png" }), "library", { onProgress: (value) => progress.push(value) });
        assert.equal(result.mediaId, "media-1");
        assert.ok(body instanceof FormData);
        assert.deepEqual(progress, [25]);
    } finally {
        restorePost();
    }
});


test("preserves uncertain image task state instead of treating it as a new failure", async () => {
    const previous = axios.get;
    axios.get = (async () => ({ data: { code: 0, data: { id: "task-uncertain", status: "uncertain", error: "提交结果待确认", images: [] } } })) as typeof axios.get;
    try {
        const task = await getImageGenerationTask("task-uncertain");
        assert.equal(task.status, "uncertain");
        assert.equal(task.error, "提交结果待确认");
    } finally {
        axios.get = previous;
    }
});

test("classifies an image generation 409 as an explicit request rejection", async () => {
    const restorePost = withAxiosPost((async () => {
        throw Object.assign(new Error("conflict"), {
            isAxiosError: true,
            response: { status: 409, data: { code: 1, data: null, msg: "客户端请求 ID 已用于不同生成请求" } },
        });
    }) as AxiosPost);
    try {
        await assert.rejects(
            requestGeneration({ quality: "auto", size: "1:1", resolution: "1k", outputFormat: "jpeg", background: "auto" } as never, "prompt", "client"),
            (error: unknown) => error instanceof ImageRequestRejectedError && error.message.includes("不同生成请求"),
        );
    } finally {
        restorePost();
    }
});
