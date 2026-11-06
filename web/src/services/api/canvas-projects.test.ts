import assert from "node:assert/strict";
import test from "node:test";

import axios from "axios";

import { createCanvasProject, deleteCanvasProject, fetchCanvasProject, fetchCanvasProjects, importCanvasProjects, updateCanvasProject, type CanvasProjectDocument } from "./canvas-projects.ts";

const document: CanvasProjectDocument = {
    nodes: [{ id: "preview", type: "image", title: "preview", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { mediaId: "media-1", content: "blob:local-preview" } } as never],
    connections: [],
    backgroundMode: "lines",
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
};

test("uses the typed canvas CRUD and import endpoints", async () => {
    const originalRequest = axios.request;
    const requests: Array<{ url?: string; method?: string; data?: unknown; headers?: unknown }> = [];
    axios.request = (async (config) => {
        requests.push(config);
        return { status: 200, data: { code: 0, data: config.method === "DELETE" ? true : { items: [], total: 0 }, msg: "ok" } } as never;
    }) as typeof axios.request;

    try {
        await fetchCanvasProjects();
        await fetchCanvasProject("project/1");
        await createCanvasProject({ id: "project-1", title: "新画布", document });
        await importCanvasProjects([{ id: "project-1", title: "导入画布", document }]);
        await updateCanvasProject("project-1", { revision: 1, title: "更新画布", document }, { tabId: "tab-a", requestId: "tab-a-7", requestSeq: 7, reason: "autosave" });
        await deleteCanvasProject("project-1", 2);
        const sanitizedDocument = { ...document, nodes: [{ ...document.nodes[0], metadata: { mediaId: "media-1" } }] };

        assert.deepEqual(
            requests.map(({ url, method, data, headers }) => ({ url, method, data, headers })),
            [
                { url: "/api/v1/canvas/projects", method: "GET", data: undefined, headers: undefined },
                { url: "/api/v1/canvas/projects/project%2F1", method: "GET", data: undefined, headers: undefined },
                { url: "/api/v1/canvas/projects", method: "POST", data: { id: "project-1", title: "新画布", document: sanitizedDocument }, headers: { "Content-Type": "application/json" } },
                { url: "/api/v1/canvas/projects/import", method: "POST", data: { projects: [{ id: "project-1", title: "导入画布", document: sanitizedDocument }] }, headers: { "Content-Type": "application/json" } },
                {
                    url: "/api/v1/canvas/projects/project-1",
                    method: "PUT",
                    data: { revision: 1, title: "更新画布", document: sanitizedDocument },
                    headers: {
                        "Content-Type": "application/json",
                        "X-Canvas-Request-Id": "tab-a-7",
                        "X-Canvas-Request-Seq": "7",
                        "X-Canvas-Save-Reason": "autosave",
                        "X-Canvas-Tab-Id": "tab-a",
                        "X-Canvas-Save-Response": "summary",
                    },
                },
                { url: "/api/v1/canvas/projects/project-1", method: "DELETE", data: { revision: 2 }, headers: { "Content-Type": "application/json" } },
            ],
        );
    } finally {
        axios.request = originalRequest;
    }
});

test("imports large UTF-8 documents in sequential bounded batches and combines results", async () => {
    const originalRequest = axios.request;
    const batches: string[][] = [];
    let inFlight = false;
    axios.request = (async (config) => {
        assert.equal(inFlight, false);
        inFlight = true;
        const { projects } = config.data as { projects: Array<{ id: string }> };
        assert.ok(new TextEncoder().encode(JSON.stringify(config.data)).byteLength <= 8 << 20);
        batches.push(projects.map((project: { id: string }) => project.id));
        await Promise.resolve();
        inFlight = false;
        return { status: 200, data: { code: 0, data: { items: projects, total: projects.length }, msg: "ok" } } as never;
    }) as typeof axios.request;
    try {
        const largeDocument = { ...document, nodes: [{ id: "text", type: "text", metadata: { content: "字".repeat(1 << 20) } }] } as CanvasProjectDocument;
        const result = await importCanvasProjects([0, 1, 2].map((index) => ({ id: `project-${index}`, title: "导入", document: largeDocument })));
        assert.deepEqual(batches, [["project-0", "project-1"], ["project-2"]]);
        assert.deepEqual(result.items.map((item) => item.id), ["project-0", "project-1", "project-2"]);
        assert.equal(result.total, 3);
    } finally {
        axios.request = originalRequest;
    }
});

test("stops a failed import batch without sending later batches", async () => {
    const originalRequest = axios.request;
    let requests = 0;
    axios.request = (async () => {
        requests++;
        throw new Error("import failed");
    }) as typeof axios.request;
    try {
        await assert.rejects(importCanvasProjects(Array.from({ length: 401 }, (_, index) => ({ id: `project-${index}`, title: "导入", document }))), /接口连接失败/);
        assert.equal(requests, 1);
    } finally {
        axios.request = originalRequest;
    }
});
