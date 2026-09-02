import assert from "node:assert/strict";
import test from "node:test";

import { CanvasNodeType } from "@/app/(user)/canvas/types";
import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import type { CanvasProjectRecord, CanvasProjectsApi } from "./api/canvas-projects";
import { bootstrapCanvasProjects, normalizeLegacyCanvasProject, retryCanvasBootstrapOnOnline } from "./canvas-project-bootstrap.ts";

function localProject(overrides: Partial<CanvasProject> = {}): CanvasProject {
    return {
        id: "local-project",
        title: "本地画布",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T01:00:00.000Z",
        nodes: [],
        connections: [],
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        ...overrides,
    };
}

function serverProject(id: string): CanvasProjectRecord {
    const project = localProject({ id, title: `服务器 ${id}` });
    return {
        id: project.id,
        title: project.title,
        revision: 1,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        document: {
            nodes: project.nodes,
            connections: project.connections,
            backgroundMode: project.backgroundMode,
            showImageInfo: project.showImageInfo,
            viewport: project.viewport,
        },
    };
}

test("lists first, imports every missing local ID once, then replaces and enables sync", async () => {
    const events: string[] = [];
    const remote = serverProject("remote-project");
    const imported = serverProject("local-project");
    const api = {
        list: async () => {
            events.push("list");
            return { items: [remote], total: 1 };
        },
        importProjects: async (projects) => {
            events.push(`import:${projects.map((project) => project.id).join(",")}`);
            return { items: [imported], total: 1 };
        },
    } as Pick<CanvasProjectsApi, "list" | "importProjects">;
    let replacement: CanvasProjectRecord[] = [];

    await bootstrapCanvasProjects({
        uid: "portal-user",
        getProjects: () => {
            events.push("projects");
            return [localProject(), localProject({ id: "remote-project" })];
        },
        api,
        replaceProjectsFromServer: (projects) => {
            events.push("replace");
            replacement = projects;
        },
        startSync: (uid) => events.push(`start:${uid}`),
        imageDependencies: {
            getImageBlob: async () => null,
            uploadUserImage: async () => {
                throw new Error("没有 legacy 图片时不应上传");
            },
            primeStableImage: async () => {
                throw new Error("没有 legacy 图片时不应写缓存");
            },
        },
    });

    assert.deepEqual(events, ["list", "projects", "import:local-project", "replace", "start:portal-user"]);
    assert.deepEqual(
        replacement.map((project) => project.id),
        ["remote-project", "local-project"],
    );
});

test("does not replace local data or enable sync when the initial server list fails", async () => {
    const events: string[] = [];
    await assert.rejects(
        () =>
            bootstrapCanvasProjects({
                uid: "portal-user",
                getProjects: () => [localProject()],
                api: {
                    list: async () => {
                        events.push("list");
                        throw new Error("network unavailable");
                    },
                    importProjects: async () => {
                        events.push("import");
                        return { items: [], total: 0 };
                    },
                },
                replaceProjectsFromServer: () => events.push("replace"),
                startSync: () => events.push("start"),
                imageDependencies: {
                    getImageBlob: async () => null,
                    uploadUserImage: async () => {
                        throw new Error("不应上传");
                    },
                    primeStableImage: async () => {
                        throw new Error("不应写缓存");
                    },
                },
            }),
        /network unavailable/,
    );

    assert.deepEqual(events, ["list"]);
});

test("normalizes a legacy cached image into long-lived library media without transient content", async () => {
    const cached = new Blob(["cached-image"], { type: "image/png" });
    const embedded = "data:image/png;base64,ZW1iZWRkZWQ=";
    const calls: string[] = [];
    const project = localProject({
        nodes: [
            {
                id: "legacy-image",
                type: CanvasNodeType.Image,
                title: "旧图片",
                position: { x: 0, y: 0 },
                width: 320,
                height: 240,
                metadata: { content: embedded, storageKey: "image:legacy", status: "error", errorDetails: "旧错误" },
            },
        ],
    });

    const normalized = await normalizeLegacyCanvasProject(project, {
        getImageBlob: async (storageKey) => {
            calls.push(`read:${storageKey}`);
            return cached;
        },
        uploadUserImage: async (file, intent) => {
            calls.push(`upload:${intent}:${await file.text()}`);
            return { mediaId: "media-stable", url: "https://signed.example/image?X-Amz-Signature=secret", mediaExpiresAt: "2099-01-01T00:00:00Z" };
        },
        primeStableImage: async (blob, mediaId) => {
            calls.push(`prime:${mediaId}:${await blob.text()}`);
            return { storageKey: "media:media-stable:v1:original", width: 640, height: 480, bytes: blob.size, mimeType: blob.type };
        },
    });

    assert.deepEqual(calls, ["read:image:legacy", "upload:library:cached-image", "prime:media-stable:cached-image"]);
    assert.deepEqual(normalized.nodes[0]?.metadata, {
        mediaId: "media-stable",
        storageKey: "media:media-stable:v1:original",
        mediaExpiresAt: "2099-01-01T00:00:00Z",
        naturalWidth: 640,
        naturalHeight: 480,
        bytes: cached.size,
        mimeType: "image/png",
        status: "success",
    });
});

test("uses an embedded data image when cache recovery misses and marks unrecoverable nodes clearly", async () => {
    const project = localProject({
        nodes: [
            {
                id: "embedded-image",
                type: CanvasNodeType.Image,
                title: "内嵌图片",
                position: { x: 0, y: 0 },
                width: 10,
                height: 10,
                metadata: { content: "data:image/png;base64,c291cmNl", storageKey: "image:missing" },
            },
            {
                id: "lost-image",
                type: CanvasNodeType.Image,
                title: "丢失图片",
                position: { x: 20, y: 0 },
                width: 10,
                height: 10,
                metadata: { content: "blob:expired", storageKey: "image:lost" },
            },
            {
                id: "public-image",
                type: CanvasNodeType.Image,
                title: "公共图片",
                position: { x: 40, y: 0 },
                width: 10,
                height: 10,
                metadata: { content: "blob:public", publicImageId: "public-1" },
            },
        ],
    });
    const uploads: string[] = [];

    const normalized = await normalizeLegacyCanvasProject(project, {
        getImageBlob: async () => null,
        uploadUserImage: async (file, intent) => {
            uploads.push(`${intent}:${await file.text()}`);
            return { mediaId: "media-from-data", url: "blob:must-not-persist" };
        },
        primeStableImage: async (blob, mediaId) => ({ storageKey: `media:${mediaId}:v1:original`, width: 10, height: 10, bytes: blob.size, mimeType: blob.type }),
    });

    assert.deepEqual(uploads, ["library:source"]);
    assert.equal(normalized.nodes[0]?.metadata?.mediaId, "media-from-data");
    assert.equal(normalized.nodes[0]?.metadata?.content, undefined);
    assert.equal(normalized.nodes[1]?.metadata?.status, "error");
    assert.match(normalized.nodes[1]?.metadata?.errorDetails || "", /本地图片无法恢复/);
    assert.equal(normalized.nodes[1]?.metadata?.content, undefined);
    assert.deepEqual(normalized.nodes[2]?.metadata, { publicImageId: "public-1" });
});

test("retries a failed authenticated bootstrap on the next online event and stops after success", async () => {
    const listeners = new Set<() => void>();
    const target = {
        addEventListener: (event: string, listener: () => void) => {
            assert.equal(event, "online");
            listeners.add(listener);
        },
        removeEventListener: (event: string, listener: () => void) => {
            assert.equal(event, "online");
            listeners.delete(listener);
        },
    };
    let attempts = 0;
    const retry = retryCanvasBootstrapOnOnline(
        async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("offline");
        },
        target,
    );

    await retry.attempt();
    assert.equal(attempts, 1);
    assert.equal(listeners.size, 1);

    listeners.forEach((listener) => listener());
    await retry.whenIdle();
    assert.equal(attempts, 2);
    assert.equal(listeners.size, 0);

    retry.dispose();
});

test("persists normalized legacy media locally so a failed import retry does not upload it twice", async () => {
    let projects = [
        localProject({
            nodes: [
                {
                    id: "legacy-image",
                    type: CanvasNodeType.Image,
                    title: "旧图片",
                    position: { x: 0, y: 0 },
                    width: 10,
                    height: 10,
                    metadata: { content: "data:image/png;base64,c291cmNl" },
                },
            ],
        }),
    ];
    let uploadCount = 0;
    let importCount = 0;
    const attempt = () =>
        bootstrapCanvasProjects({
            uid: "portal-user",
            getProjects: () => projects,
            api: {
                list: async () => ({ items: [], total: 0 }),
                importProjects: async () => {
                    importCount += 1;
                    if (importCount === 1) throw new Error("import unavailable");
                    return { items: [serverProject("local-project")], total: 1 };
                },
            },
            persistNormalizedProject: (id, nodes) => {
                projects = projects.map((project) => (project.id === id ? { ...project, nodes } : project));
            },
            replaceProjectsFromServer: () => undefined,
            startSync: () => undefined,
            imageDependencies: {
                getImageBlob: async () => null,
                uploadUserImage: async () => {
                    uploadCount += 1;
                    return { mediaId: "stable-media", url: "https://signed.example/image" };
                },
                primeStableImage: async (blob, mediaId) => ({ storageKey: `media:${mediaId}:v1:original`, width: 10, height: 10, bytes: blob.size, mimeType: blob.type }),
            },
        });

    await assert.rejects(attempt, /import unavailable/);
    await attempt();

    assert.equal(uploadCount, 1);
    assert.equal(projects[0]?.nodes[0]?.metadata?.mediaId, "stable-media");
});
