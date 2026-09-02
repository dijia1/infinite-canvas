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
    const requests: Array<{ url?: string; method?: string; data?: unknown }> = [];
    axios.request = (async (config) => {
        requests.push(config);
        return { status: 200, data: { code: 0, data: config.method === "DELETE" ? true : { items: [], total: 0 }, msg: "ok" } } as never;
    }) as typeof axios.request;

    try {
        await fetchCanvasProjects();
        await fetchCanvasProject("project/1");
        await createCanvasProject({ id: "project-1", title: "新画布", document });
        await importCanvasProjects([{ id: "project-1", title: "导入画布", document }]);
        await updateCanvasProject("project-1", { revision: 1, title: "更新画布", document });
        await deleteCanvasProject("project-1", 2);
        const sanitizedDocument = { ...document, nodes: [{ ...document.nodes[0], metadata: { mediaId: "media-1" } }] };

        assert.deepEqual(
            requests.map(({ url, method, data }) => ({ url, method, data })),
            [
                { url: "/api/v1/canvas/projects", method: "GET", data: undefined },
                { url: "/api/v1/canvas/projects/project%2F1", method: "GET", data: undefined },
                { url: "/api/v1/canvas/projects", method: "POST", data: { id: "project-1", title: "新画布", document: sanitizedDocument } },
                { url: "/api/v1/canvas/projects/import", method: "POST", data: { projects: [{ id: "project-1", title: "导入画布", document: sanitizedDocument }] } },
                { url: "/api/v1/canvas/projects/project-1", method: "PUT", data: { revision: 1, title: "更新画布", document: sanitizedDocument } },
                { url: "/api/v1/canvas/projects/project-1", method: "DELETE", data: { revision: 2 } },
            ],
        );
    } finally {
        axios.request = originalRequest;
    }
});
