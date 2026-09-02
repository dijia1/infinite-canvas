import assert from "node:assert/strict";
import test from "node:test";

import type { CanvasProjectSync } from "../stores/use-canvas-store";
import { describeCanvasSync, refreshCanvasServerVersion } from "./canvas-sync-feedback.tsx";

function sync(overrides: Partial<CanvasProjectSync> = {}): CanvasProjectSync {
    return {
        serverRevision: 1,
        dirty: false,
        pending: false,
        saving: false,
        offline: false,
        error: null,
        conflict: false,
        operation: "save",
        ...overrides,
    };
}

test("describes clean, saving, offline pending, error, and conflict project states", () => {
    assert.deepEqual(describeCanvasSync(sync()), { label: "已保存", kind: "saved", refreshable: false });
    assert.deepEqual(describeCanvasSync(sync({ saving: true })), { label: "保存中", kind: "saving", refreshable: false });
    assert.deepEqual(describeCanvasSync(sync({ dirty: true, pending: true, offline: true })), { label: "离线待同步", kind: "offline", refreshable: false });
    assert.deepEqual(describeCanvasSync(sync({ dirty: true, pending: true, error: "网络错误" })), { label: "保存失败", kind: "error", refreshable: false });
    assert.deepEqual(describeCanvasSync(sync({ dirty: true, conflict: true, error: "版本冲突" })), { label: "版本冲突", kind: "conflict", refreshable: true });
});

test("treats online dirty or pending work as saving feedback", () => {
    assert.deepEqual(describeCanvasSync(sync({ dirty: true, pending: true })), { label: "保存中", kind: "saving", refreshable: false });
});

test("refreshes the server record before replacing an open canvas local state", async () => {
    const events: string[] = [];
    await refreshCanvasServerVersion("project-1", {
        refreshProjectFromServer: async (id) => {
            events.push(`refresh:${id}`);
        },
        readProject: (id) => {
            events.push(`read:${id}`);
            return { id, title: "服务器版本" };
        },
        restoreProject: async (project) => {
            events.push(`restore:${project.title}`);
        },
    });

    assert.deepEqual(events, ["refresh:project-1", "read:project-1", "restore:服务器版本"]);
});
