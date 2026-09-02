import assert from "node:assert/strict";
import test from "node:test";

import type { CanvasProjectSync } from "../stores/use-canvas-store";
import { describeCanvasBootstrap, describeCanvasSync } from "./canvas-sync-feedback.tsx";

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

test("describes authenticated bootstrap errors separately from offline and hides guest feedback", () => {
    assert.deepEqual(describeCanvasBootstrap("error", "portal-user", "网关超时"), { label: "同步连接失败", kind: "error", detail: "网关超时" });
    assert.deepEqual(describeCanvasBootstrap("offline", "portal-user", "网络不可用"), { label: "离线使用", kind: "offline", detail: "网络不可用" });
    assert.equal(describeCanvasBootstrap("ready", "portal-user", null), null);
    assert.equal(describeCanvasBootstrap("error", "guest", "不应显示"), null);
    assert.equal(describeCanvasBootstrap("error", null, "不应显示"), null);
});
