import assert from "node:assert/strict";
import test from "node:test";

import { CanvasNodeType } from "@/app/(user)/canvas/types";
import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";
import type { CanvasProjectRecord, CanvasProjectsApi, CreateCanvasProjectInput } from "./api/canvas-projects";
import { bootstrapCanvasProjects, mergeNormalizedLegacyNodes, normalizeLegacyCanvasProject, retryCanvasBootstrapOnOnline } from "./canvas-project-bootstrap.ts";

function localProject(overrides: Partial<CanvasProject> = {}): CanvasProject {
    return {
        id: "local-project",
        title: "本地画布",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T01:00:00.000Z",
        nodes: [],
        maskResources: {},
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
        adoptImportedProjects: (projects, snapshots) => {
            events.push(`adopt:${projects[0]?.revision}:${snapshots.get("local-project")?.title}`);
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

    assert.deepEqual(events, ["list", "projects", "projects", "import:local-project", "adopt:1:本地画布", "replace", "start:portal-user"]);
    assert.deepEqual(
        replacement.map((project) => project.id),
        ["remote-project", "local-project"],
    );
});

test("chunks more than two hundred legacy projects to the backend import limit", async () => {
    const local = Array.from({ length: 205 }, (_, index) => localProject({ id: `legacy-${String(index).padStart(3, "0")}` }));
    const chunkSizes: number[] = [];
    let adopted: CanvasProjectRecord[] = [];
    let replacement: CanvasProjectRecord[] = [];

    await bootstrapCanvasProjects({
        uid: "portal-user",
        getProjects: () => local,
        api: {
            list: async () => ({ items: [], total: 0 }),
            importProjects: async (projects) => {
                chunkSizes.push(projects.length);
                const items = projects.map((project) => serverProject(project.id));
                return { items, total: items.length };
            },
        },
        adoptImportedProjects: (projects, snapshots) => {
            adopted = projects;
            assert.equal(snapshots.size, 205);
        },
        replaceProjectsFromServer: (projects) => {
            replacement = projects;
        },
        startSync: () => undefined,
    });

    assert.deepEqual(chunkSizes, [200, 5]);
    assert.equal(adopted.length, 205);
    assert.equal(replacement.length, 205);
    assert.equal(new Set(replacement.map((project) => project.id)).size, 205);
});

test("imports a project created while listing and snapshots later rename/delete races for revision adoption", async () => {
    let projects = [localProject({ id: "existing" })];
    let resolveList!: (value: { items: CanvasProjectRecord[]; total: number }) => void;
    const list = new Promise<{ items: CanvasProjectRecord[]; total: number }>((resolve) => (resolveList = resolve));
    let resolveImport!: (value: { items: CanvasProjectRecord[]; total: number }) => void;
    const importing = new Promise<{ items: CanvasProjectRecord[]; total: number }>((resolve) => (resolveImport = resolve));
    let importedIds: string[] = [];
    let adoptedSnapshot: CanvasProject | undefined;

    const bootstrap = bootstrapCanvasProjects({
        uid: "portal-user",
        getProjects: () => projects,
        api: {
            list: async () => list,
            importProjects: async (inputs) => {
                importedIds = inputs.map((input) => input.id);
                return importing;
            },
        },
        adoptImportedProjects: (_records, snapshots) => {
            adoptedSnapshot = snapshots.get("created-during-list");
        },
        replaceProjectsFromServer: () => undefined,
        startSync: () => undefined,
    });

    projects = [...projects, localProject({ id: "created-during-list", title: "导入快照" })];
    resolveList({ items: [serverProject("existing")], total: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(importedIds, ["created-during-list"]);
    projects = projects.map((project) => (project.id === "created-during-list" ? { ...project, title: "导入中重命名" } : project));
    resolveImport({ items: [serverProject("created-during-list")], total: 1 });
    await bootstrap;

    assert.equal(adoptedSnapshot?.title, "导入快照");
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

test("bypasses stable media nodes with local blob previews while importing a sanitized document", async () => {
    const stable = localProject({
        nodes: [
            {
                id: "stable-image",
                type: CanvasNodeType.Image,
                title: "稳定图片",
                position: { x: 0, y: 0 },
                width: 10,
                height: 10,
                metadata: { mediaId: "media-stable", storageKey: "media:media-stable:v1:original", content: "blob:local-preview", status: "success" },
            },
        ],
    });
    let persisted = false;
    let imported: CreateCanvasProjectInput | undefined;

    await bootstrapCanvasProjects({
        uid: "portal-user",
        getProjects: () => [stable],
        api: {
            list: async () => ({ items: [], total: 0 }),
            importProjects: async (inputs) => {
                imported = inputs[0];
                return { items: [serverProject(stable.id)], total: 1 };
            },
        },
        persistNormalizedProject: () => {
            persisted = true;
            return false;
        },
        replaceProjectsFromServer: () => undefined,
        startSync: () => undefined,
        imageDependencies: {
            getImageBlob: async () => {
                throw new Error("稳定节点不应读取 legacy 缓存");
            },
            uploadUserImage: async () => {
                throw new Error("稳定节点不应重新上传");
            },
            primeStableImage: async () => {
                throw new Error("稳定节点不应重写缓存");
            },
        },
    });

    assert.equal(persisted, false);
    assert.equal(stable.nodes[0]?.metadata?.content, "blob:local-preview");
    assert.equal(imported?.document.nodes[0]?.metadata?.mediaId, "media-stable");
    assert.equal(imported?.document.nodes[0]?.metadata?.content, undefined);
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
    assert.deepEqual(normalized.nodes[2]?.metadata, { content: "blob:public", publicImageId: "public-1" });
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
            persistNormalizedProject: (id, capturedNodes, normalizedNodes) => {
                projects = projects.map((project) => (project.id === id ? { ...project, nodes: mergeNormalizedLegacyNodes(project.nodes, capturedNodes, normalizedNodes).nodes } : project));
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

test("merges delayed legacy media normalization into the current project without overwriting concurrent node work", async () => {
    const legacy = {
        id: "legacy-image",
        type: CanvasNodeType.Image,
        title: "旧图片",
        position: { x: 0, y: 0 },
        width: 10,
        height: 10,
        metadata: { content: "data:image/png;base64,c291cmNl", prompt: "旧提示" },
    };
    let projects = [localProject({ nodes: [legacy] })];
    let releaseUpload!: () => void;
    const uploadDelay = new Promise<void>((resolve) => (releaseUpload = resolve));
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => (uploadStarted = resolve));
    let imported: CreateCanvasProjectInput | undefined;

    const bootstrap = bootstrapCanvasProjects({
        uid: "portal-user",
        getProjects: () => projects,
        api: {
            list: async () => ({ items: [], total: 0 }),
            importProjects: async (inputs) => {
                imported = inputs[0];
                return { items: [serverProject("local-project")], total: 1 };
            },
        },
        persistNormalizedProject: (id, capturedNodes, normalizedNodes) => {
            const project = projects.find((item) => item.id === id)!;
            const merged = mergeNormalizedLegacyNodes(project.nodes, capturedNodes, normalizedNodes);
            projects = projects.map((item) => (item.id === id ? { ...item, nodes: merged.nodes } : item));
            return merged.complete;
        },
        replaceProjectsFromServer: () => undefined,
        startSync: () => undefined,
        imageDependencies: {
            getImageBlob: async () => null,
            uploadUserImage: async () => {
                uploadStarted();
                await uploadDelay;
                return { mediaId: "stable-media", url: "https://signed.example/image" };
            },
            primeStableImage: async (blob, mediaId) => ({ storageKey: `media:${mediaId}:v1:original`, width: 10, height: 10, bytes: blob.size, mimeType: blob.type }),
        },
    });

    await started;
    projects = projects.map((project) => ({
        ...project,
        nodes: [
            { ...project.nodes[0]!, title: "并发改名", metadata: { ...project.nodes[0]!.metadata, prompt: "并发提示" } },
            { id: "new-text", type: CanvasNodeType.Text, title: "新节点", position: { x: 20, y: 20 }, width: 100, height: 80, metadata: { content: "并发新增" } },
        ],
    }));
    releaseUpload();
    await bootstrap;

    assert.equal(imported?.document.nodes.length, 2);
    assert.equal(imported?.document.nodes[0]?.title, "并发改名");
    assert.equal(imported?.document.nodes[0]?.metadata?.prompt, "并发提示");
    assert.equal(imported?.document.nodes[0]?.metadata?.mediaId, "stable-media");
    assert.equal(imported?.document.nodes[0]?.metadata?.content, undefined);
    assert.equal(imported?.document.nodes[1]?.id, "new-text");
});

test("defers normalization when the captured legacy source changed incompatibly", () => {
    const captured = localProject({ nodes: [{ id: "image", type: CanvasNodeType.Image, title: "图", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { content: "data:image/png;base64,b2xk" } }] }).nodes;
    const normalized = [{ ...captured[0]!, metadata: { mediaId: "uploaded-old", storageKey: "media:uploaded-old:v1:original", status: "success" as const } }];
    const current = [{ ...captured[0]!, metadata: { content: "data:image/png;base64,bmV3" } }];

    const merged = mergeNormalizedLegacyNodes(current, captured, normalized);

    assert.equal(merged.complete, false);
    assert.equal(merged.nodes, current);
    assert.equal(merged.nodes[0]?.metadata?.content, "data:image/png;base64,bmV3");
});

test("aborts bootstrap upload failures without replacing the original retryable local source", async () => {
    const source = localProject({
        nodes: [
            {
                id: "retryable-image",
                type: CanvasNodeType.Image,
                title: "可重试图片",
                position: { x: 0, y: 0 },
                width: 10,
                height: 10,
                metadata: { content: "data:image/png;base64,c291cmNl", storageKey: "image:retryable" },
            },
        ],
    });

    await assert.rejects(
        () =>
            normalizeLegacyCanvasProject(source, {
                getImageBlob: async () => null,
                uploadUserImage: async () => {
                    throw new Error("network unavailable");
                },
                primeStableImage: async () => {
                    throw new Error("不应写缓存");
                },
            }),
        /network unavailable/,
    );
    assert.deepEqual(source.nodes[0]?.metadata, { content: "data:image/png;base64,c291cmNl", storageKey: "image:retryable" });
});

test("aborts bootstrap when the only possible cached source cannot be read", async () => {
    const project = localProject({
        nodes: [{ id: "legacy", type: CanvasNodeType.Image, title: "旧图", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { storageKey: "image:legacy" } }],
    });
    await assert.rejects(
        () =>
            normalizeLegacyCanvasProject(project, {
                getImageBlob: async () => {
                    throw new Error("indexeddb unavailable");
                },
                uploadUserImage: async () => ({ mediaId: "never", url: "" }),
                primeStableImage: async () => ({ storageKey: "never", width: 1, height: 1, bytes: 1, mimeType: "image/png" }),
            }),
        /indexeddb unavailable/,
    );
    assert.deepEqual(project.nodes[0]?.metadata, { storageKey: "image:legacy" });
});

test("keeps uploaded stable media metadata when local cache priming fails", async () => {
    const normalized = await normalizeLegacyCanvasProject(
        localProject({
            nodes: [
                {
                    id: "uploaded-image",
                    type: CanvasNodeType.Image,
                    title: "已上传图片",
                    position: { x: 0, y: 0 },
                    width: 320,
                    height: 180,
                    metadata: { content: "data:image/png;base64,c291cmNl", naturalWidth: 640, naturalHeight: 360, mimeType: "image/png" },
                },
            ],
        }),
        {
            getImageBlob: async () => null,
            uploadUserImage: async () => ({ mediaId: "uploaded-media", url: "https://signed.example/image", mediaExpiresAt: "2099-01-01T00:00:00Z" }),
            primeStableImage: async () => {
                throw new Error("indexeddb unavailable");
            },
        },
    );

    assert.deepEqual(normalized.nodes[0]?.metadata, {
        mediaId: "uploaded-media",
        storageKey: "media:uploaded-media:v1:original",
        mediaExpiresAt: "2099-01-01T00:00:00Z",
        naturalWidth: 640,
        naturalHeight: 360,
        bytes: 6,
        mimeType: "image/png",
        status: "success",
    });
});
