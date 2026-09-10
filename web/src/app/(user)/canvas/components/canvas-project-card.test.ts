import assert from "node:assert/strict";
import test from "node:test";

import { deferred, elements, flushAsync, hookHarness, sourceModule } from "@/test-utils/source-component";
import type { CanvasSummary } from "@/services/api/canvas-projects";
import type { CanvasProjectCard } from "./canvas-project-card";
import * as cardActions from "./canvas-project-card-actions";

const summary: CanvasSummary = {
    id: "project-1",
    title: "旧目录标题",
    revision: 2,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    nodeCount: 0,
    connectionCount: 0,
};

const loadedProject = {
    id: summary.id,
    title: "服务器新标题",
    createdAt: summary.createdAt,
    updatedAt: "2026-09-03T00:00:00Z",
    nodes: [],
    connections: [],
    maskResources: {},
    backgroundMode: "lines" as const,
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
};

function environment(ensureProjectDetail: () => Promise<typeof loadedProject>) {
    const harness = hookHarness();
    const messages: string[] = [];
    const renamed: string[] = [];
    let duplicateCalls = 0;
    const state = {
        ensureProjectDetail,
        duplicateProject: () => {
            duplicateCalls += 1;
            return "copy-1";
        },
        renameProject: (_id: string, title: string) => {
            renamed.push(title);
        },
        projects: [] as (typeof loadedProject)[],
        projectSync: {
            [summary.id]: {
                serverRevision: 2,
                dirty: false,
                pending: false,
                saving: false,
                offline: false,
                error: null,
                conflict: false,
                operation: "save" as const,
            },
        },
        summaries: [summary],
        summariesLoaded: true,
        syncScope: "owner",
    };
    const ui = {
        editingProjectId: null as string | null,
        editingProjectTitle: "",
        startEditingProject: (id: string, title: string) => {
            ui.editingProjectId = id;
            ui.editingProjectTitle = title;
        },
        setEditingProjectTitle: (title: string) => {
            ui.editingProjectTitle = title;
        },
        stopEditingProject: () => {
            ui.editingProjectId = null;
        },
        setDeleteProjectIds: () => {},
    };
    const useCanvasStore = Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state });
    const component = sourceModule<{ CanvasProjectCard: typeof CanvasProjectCard }>(new URL("./canvas-project-card.tsx", import.meta.url), {
        react: harness.hooks,
        "lucide-react": { Check: "Check", Copy: "Copy", Pencil: "Pencil", Share2: "Share2", Trash2: "Trash2", X: "X" },
        "next/navigation": { useRouter: () => ({ push: () => {} }) },
        antd: {
            App: { useApp: () => ({ message: { error: (value: string) => messages.push(`error:${value}`), success: (value: string) => messages.push(`success:${value}`) } }) },
            Button: "Button",
            Input: "Input",
        },
        "@/lib/app-path": { appPath: (value: string) => value },
        "../stores/use-canvas-store": { useCanvasStore },
        "../stores/use-canvas-ui-store": { useCanvasUiStore: (selector: (value: typeof ui) => unknown) => selector(ui) },
        "./canvas-share-dialog": { CanvasShareDialog: "CanvasShareDialog" },
        "./canvas-sync-feedback": { CanvasSyncFeedback: "CanvasSyncFeedback" },
        "./canvas-project-card-actions": cardActions,
    });
    const render = () => harness.render(() => component.CanvasProjectCard({ project: summary }));
    const button = (tree: unknown, label: string) => elements(tree, (element) => element.type === "Button" && element.props["aria-label"] === label)[0]!;
    return { harness, messages, renamed, state, ui, render, button, duplicateCalls: () => duplicateCalls };
}

test("an untouched rename does not overwrite a newer title loaded at action time", async () => {
    const response = deferred<typeof loadedProject>();
    const e = environment(async () => {
        const project = await response.promise;
        e.state.projects = [project];
        e.state.projectSync[summary.id] = { ...e.state.projectSync[summary.id], serverRevision: 3 };
        return project;
    });

    e.button(e.render(), "重命名").props.onClick();
    const editing = e.render();
    e.button(editing, "保存名称").props.onClick();
    response.resolve(loadedProject);
    await flushAsync();

    assert.deepEqual(e.renamed, [loadedProject.title]);
    assert.equal(e.ui.editingProjectId, null);
    e.harness.unmount();
});

test("unmounting while detail loads cancels card mutations, messages, and state updates", async () => {
    const response = deferred<typeof loadedProject>();
    const e = environment(async () => {
        const project = await response.promise;
        e.state.projects = [project];
        return project;
    });

    e.button(e.render(), "复制画布").props.onClick();
    e.harness.unmount();
    response.resolve(loadedProject);
    await flushAsync();

    assert.equal(e.duplicateCalls(), 0);
    assert.deepEqual(e.messages, []);
    assert.equal(e.harness.postUnmountUpdates, 0);
});
