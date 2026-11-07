import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { fetchPrivateImages } from "./private-images";

test("private media catalog preserves image default and requests videos by kind", async () => {
    const original = axios.request;
    const requests: any[] = [];
    axios.request = (async (config: unknown) => { requests.push(config); return { status: 200, data: { code: 0, data: { items: [], total: 0 } } }; }) as typeof axios.request;
    try {
        await fetchPrivateImages();
        await fetchPrivateImages("video");
        assert.deepEqual(requests.map(({ url, params }) => ({ url, params })), [
            { url: "/api/v1/private-images", params: undefined },
            { url: "/api/v1/private-images", params: { kind: "video" } },
        ]);
    } finally { axios.request = original; }
});
