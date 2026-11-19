import assert from "node:assert/strict";
import test from "node:test";

import type { CanvasProjectDetail, CanvasProjectsApi } from "@/services/api/canvas-projects";
import { ApiRequestError } from "@/services/api/request";
import { deferred, flushAsync, hookHarness, sourceModule } from "@/test-utils/source-component";
import { createCanvasStore } from "../stores/use-canvas-store";
import * as leaseStorage from "./canvas-project-editor-lease";
import type { useCanvasProjectOpen } from "./use-canvas-project-open";

const record: CanvasProjectDetail = {
    id: "a", title: "server", revision: 7, createdAt: "2026-09-01", updatedAt: "2026-09-01",
    document: { nodes: [], connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 5, y: 6, k: 0.8 } },
};

function browser() {
    const held = new Set<string>();
    const channels = new Set<TestChannel>();
    class TestChannel extends EventTarget {
        constructor() {
            super();
            channels.add(this);
        }
        postMessage(data: unknown) {
            assert.ok(channels.has(this), "cannot publish on a closed channel");
            for (const channel of channels) {
                if (channel !== this) queueMicrotask(() => channel.dispatchEvent(new MessageEvent("message", { data })));
            }
        }
        close() { channels.delete(this); }
    }
    return {
        held,
        TestChannel,
        locks: {
            async request(name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) {
                if (held.has(name)) return callback(null);
                held.add(name);
                try {
                    await callback({});
                } finally {
                    held.delete(name);
                }
            },
        },
    };
}

function tab({ id = "one", client = browser(), get = async () => record }: {
    id?: string; client?: ReturnType<typeof browser>; get?: CanvasProjectsApi["get"];
} = {}) {
    const api: CanvasProjectsApi = {
        list: async () => ({ items: [], total: 0 }),
        get,
        create: async () => record,
        importProjects: async () => ({ items: [], total: 0 }),
        update: async () => record,
        delete: async () => {},
    };
    const store = createCanvasStore({ api, isOnline: () => false, storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } });
    store.setState({ syncScope: "owner", syncEnabled: true, readyForCanvasMutations: true });
    const harness = hookHarness();
    const window = new EventTarget();
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const { useCanvasProjectOpen: open } = sourceModule<{ useCanvasProjectOpen: typeof useCanvasProjectOpen }>(
        new URL("./use-canvas-project-open.ts", import.meta.url),
        {
            react: { ...harness.hooks, useLayoutEffect: harness.hooks.useEffect },
            "@/services/api/request": { ApiRequestError },
            "../stores/use-canvas-store": { useCanvasStore: { getState: store.getState } },
            "./canvas-project-editor-lease": leaseStorage,
            "./canvas-project-write-trace": { createCanvasProjectWriteTracer: () => ({ tabId: id }) },
        },
        {
            window, navigator: { locks: client.locks }, BroadcastChannel: client.TestChannel,
            setTimeout: (callback: () => void) => {
                timers.set(++timerId, callback);
                return timerId;
            },
            clearTimeout: (id: number) => { timers.delete(id); },
        },
    );
    return {
        render: (id = "a", scope = "owner", ready = true) => harness.render(() => open(id, scope, ready, () => null)),
        close: harness.unmount,
        store, client, window, timers,
        tick: async () => {
            const due = [...timers.values()];
            timers.clear();
            due.forEach(callback => callback());
            await flushAsync();
        },
    };
}

test("summary-only editor waits for bootstrap and then reads the detail once", async () => {
    const response = deferred<CanvasProjectDetail>();
    let calls = 0;
    const e = tab({ get: async () => { calls++; return response.promise; } });
    e.render("a", "owner", false);
    await flushAsync();
    assert.equal(calls, 0);
    e.render();
    await flushAsync();
    assert.equal(e.render().state.status, "loading");
    assert.equal(e.store.getState().openProject("a"), null);
    response.resolve(record);
    await flushAsync();
    assert.equal(e.render().state.status, "editable");
    assert.deepEqual(e.store.getState().openProject("a")?.viewport, record.document.viewport);
    assert.equal(calls, 1);
    e.close();
});

test("a dirty restored document keeps its content and its save baseline", async () => {
    let calls = 0;
    const e = tab({ get: async () => { calls++; return record; } });
    e.store.getState().replaceProjectsFromServer([record]);
    e.store.getState().renameProject("a", "dirty draft");
    const draft = e.store.getState().openProject("a");
    const sync = e.store.getState().projectSync.a;
    e.render();
    await flushAsync();
    assert.equal(e.render().state.status, "editable");
    assert.equal(e.store.getState().openProject("a"), draft);
    assert.deepEqual(e.store.getState().projectSync.a, sync);
    assert.equal(e.store.getState().blockedProjectSync.a, undefined);
    assert.equal(calls, 0);
    e.close();
});

test("single tab retries a stale detail response and only unlocks a valid version", async () => {
    let calls = 0;
    const e = tab({ get: async () => ({ ...record, revision: ++calls === 1 ? 6 : 8 }) });
    e.store.getState().replaceProjectsFromServer([record]);
    e.render();
    await flushAsync();
    assert.equal(e.render().state.status, "loading");
    assert.equal(e.store.getState().projectSync.a.serverRevision, 7);
    assert.equal(e.store.getState().blockedProjectSync.a, true);
    await e.tick();
    assert.equal(e.render().state.status, "editable");
    assert.equal(e.store.getState().projectSync.a.serverRevision, 8);
    assert.equal(calls, 2);
    e.close();
});

test("temporary failures stop after three reads, release the lock and allow manual reload", async () => {
    let calls = 0;
    const e = tab({ get: async () => {
        if (++calls <= 3) throw new ApiRequestError("服务暂不可用", 503, 1);
        return record;
    } });
    e.render();
    await flushAsync();
    await e.tick();
    await e.tick();
    assert.deepEqual(e.render().state, { status: "error", message: "服务暂不可用" });
    assert.equal(e.client.held.size, 0);
    assert.equal(e.store.getState().blockedProjectSync.a, true);
    assert.equal(e.timers.size, 0);
    e.render().retry();
    await flushAsync();
    assert.equal(e.render().state.status, "editable");
    assert.equal(calls, 4);
    e.close();
});

test("a missing canvas produces a direct error without automatic retries or a lock", async () => {
    const e = tab({ get: async () => { throw new ApiRequestError("画布不存在", 200, 1); } });
    e.render();
    await flushAsync();
    assert.deepEqual(e.render().state, { status: "error", message: "当前账号找不到该画布" });
    assert.equal(e.client.held.size, 0);
    assert.equal(e.timers.size, 0);
    assert.equal(e.store.getState().openProject("a"), null);
    e.close();
});

test("a second tab previews the canvas read-only and acquires after the first tab leaves", async () => {
    const first = tab();
    const second = tab({ id: "two", client: first.client });
    first.render();
    second.render();
    await flushAsync();
    assert.equal(first.render().state.status, "editable");
    assert.deepEqual(second.render().state, { status: "occupied", preview: true });
    assert.equal(second.store.getState().blockedProjectSync.a, true);
    first.close();
    await flushAsync();
    assert.equal(second.render().state.status, "editable");
    const third = tab({ id: "three", client: first.client });
    second.close();
    await flushAsync();
    third.render();
    await flushAsync();
    assert.equal(third.render().state.status, "editable");
    third.close();
});

test("pagehide releases a lock and pageshow reopens the restored tab", async () => {
    const e = tab();
    e.render();
    await flushAsync();
    e.window.dispatchEvent(new Event("pagehide"));
    await flushAsync();
    assert.equal(e.client.held.size, 0);
    assert.equal(e.render().state.status, "loading");
    e.window.dispatchEvent(new Event("pageshow"));
    await flushAsync();
    assert.equal(e.render().state.status, "editable");
    e.close();
});

test("leaving an in-flight detail read releases immediately and won't restore the old canvas", async () => {
    const pending = deferred<CanvasProjectDetail>();
    const e = tab({ get: async (id) => id === "a" ? pending.promise : { ...record, id } });
    e.render();
    await flushAsync();
    assert.equal(e.client.held.size, 1);
    e.render("b");
    await flushAsync();
    assert.deepEqual([...e.client.held], ["infinite-canvas:project-editor:b"]);
    assert.equal(e.render("b").state.status, "editable");
    pending.resolve(record);
    await flushAsync();
    assert.equal(e.render("b").state.status, "editable");
    assert.deepEqual([...e.client.held], ["infinite-canvas:project-editor:b"]);
    e.close();
});
