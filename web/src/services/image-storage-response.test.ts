import assert from "node:assert/strict";
import test from "node:test";

import { imageBlobFromResponse } from "./image-blob.ts";

test("rejects a successful response that is not an image", async () => {
    const response = new Response('{"code":1,"msg":"图片不存在"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });

    await assert.rejects(() => imageBlobFromResponse(response), /媒体服务未返回图片内容/);
});

test("preserves an OSS failure status for signed URL recovery", async () => {
    const response = new Response("forbidden", { status: 403 });

    await assert.rejects(
        () => imageBlobFromResponse(response),
        (error: unknown) => error instanceof Error && (error as Error & { status?: number }).status === 403,
    );
});
