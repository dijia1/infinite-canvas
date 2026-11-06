import assert from "node:assert/strict";
import test from "node:test";

import type { CanvasProjectSync, CanvasStore } from "../stores/use-canvas-store";
import { createCanvasProjectCardActionGate, describeCanvasSummaryCounts, loadCanvasProjectForCardAction, shareCanvasProjectStatus } from "./canvas-project-card-actions";

const project = {
    id: "project-1",
    title: "本地画布",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    nodes: [],
    maskResources: {},
    connections: [],
    backgroundMode: "lines" as const,
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
};

const summary = {
    id: project.id,
    title: project.title,
    revision: 3,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    nodeCount: 0,
    connectionCount: 0,
};

const cleanSync: CanvasProjectSync = {
    serverRevision: 3,
    dirty: false,
    pending: false,
    saving: false,
    offline: false,
    error: null,
    conflict: false,
    operation: "save",
};

function cardState(overrides: Partial<Pick<CanvasStore, "syncScope" | "summaries" | "projects" | "projectSync" | "summariesLoaded">> = {}) {
    return {
        syncScope: "owner",
        summaries: [summary],
        projects: [project],
        projectSync: { [project.id]: cleanSync },
        summariesLoaded: true,
        ...overrides,
    };
}

test("card detail action uses the latest project and revision after lazy loading", async () => {
    let state = cardState({ projects: [] });
    const loadedProject = { ...project, title: "服务器最新画布" };

    const result = await loadCanvasProjectForCardAction({
        id: project.id,
        ensureProjectDetail: async () => {
            state = cardState({ projects: [loadedProject] });
            return loadedProject;
        },
        readState: () => state,
    });

    assert.equal(result.project, loadedProject);
    assert.equal(result.summary.id, project.id);
    assert.equal(result.sync?.serverRevision, 3);
});

test("card count text comes entirely from the summary", () => {
    assert.equal(describeCanvasSummaryCounts({ ...summary, nodeCount: 12, connectionCount: 7 }), "12 个节点 · 7 条连线");
});

test("card detail action rejects a result after the account scope changes", async () => {
    let state = cardState({ projects: [] });

    await assert.rejects(
        loadCanvasProjectForCardAction({
            id: project.id,
            ensureProjectDetail: async () => {
                state = cardState({ syncScope: "another-owner", summaries: [], projects: [], projectSync: {} });
                return project;
            },
            readState: () => state,
        }),
        /已失效/,
    );
});

test("card action gate ignores a repeated click and permits a retry after failure", async () => {
    const gate = createCanvasProjectCardActionGate();
    const pending = Promise.withResolvers<void>();
    let calls = 0;
    const first = gate.run(async () => {
        calls += 1;
        await pending.promise;
        throw new Error("load failed");
    });

    assert.equal(
        await gate.run(async () => {
            calls += 1;
        }),
        false,
    );
    pending.resolve();
    await assert.rejects(first, /load failed/);
    assert.equal(
        await gate.run(async () => {
            calls += 1;
        }),
        true,
    );
    assert.equal(calls, 2);
});

test("sharing requires a current saved revision and rejects local uploads", () => {
    assert.deepEqual(shareCanvasProjectStatus(project, cleanSync), { allowed: true, revision: 3 });
    assert.deepEqual(shareCanvasProjectStatus(project, { ...cleanSync, dirty: true }), { allowed: false, reason: "等待画布保存后再分享" });
    assert.deepEqual(
        shareCanvasProjectStatus(project, {
            ...cleanSync,
            unknownRequest: { baseRevision: 3, title: project.title, document: project, trace: { tabId: "tab", requestId: "request", requestSeq: 1, reason: "autosave" } },
        }),
        { allowed: false, reason: "等待画布保存后再分享" },
    );
    assert.deepEqual(
        shareCanvasProjectStatus(
            {
                ...project,
                nodes: [{ id: "image", type: "image" as never, title: "", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { storageKey: "image:local", localUploadState: "uploading" } }],
            },
            cleanSync,
        ),
        { allowed: false, reason: "请等待本地图片上传完成后再分享" },
    );
});
