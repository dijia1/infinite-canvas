import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasStore, type CanvasStore } from "./use-canvas-store";
import type { CanvasProjectDetail, CanvasProjectsApi } from "@/services/api/canvas-projects";
import { ApiRequestError } from "@/services/api/request";
import type { PersistStorage, StorageValue } from "zustand/middleware";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const base: CanvasProjectDetail = { id: "recovery", title: "base", revision: 1, createdAt: "2026-09-17", updatedAt: "2026-09-17", document: { nodes: [], connections: [], backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } } };
function memory() {
    let value: StorageValue<CanvasStore> | null = null;
    const writes: CanvasStore[] = [];
    const storage: PersistStorage<CanvasStore> = {
        getItem: async () => structuredClone(value),
        setItem: async (_key, next) => {
            value = structuredClone(next);
            writes.push(value.state as CanvasStore);
        },
        removeItem: async () => {
            value = null;
        },
    };
    return { storage, writes, read: () => structuredClone(value) };
}
let storeSequence = 0;
function setup(storage: PersistStorage<CanvasStore>, update: CanvasProjectsApi["update"], extra: Partial<CanvasProjectsApi> = {}) {
    let seq = 0;
    const instance = ++storeSequence;
    const api: CanvasProjectsApi = { list: async () => ({ items: [], total: 0 }), get: async () => base, create: async (input) => ({ ...base, ...input }), importProjects: async () => ({ items: [], total: 0 }), delete: async () => {}, update, ...extra };
    const store = createCanvasStore({ storage, api, serverDebounceMs: 0, isOnline: () => true, writeTracer: { next: (reason) => ({ tabId: "tab", requestId: `request-${instance}-${++seq}`, requestSeq: seq, reason }) } });
    return store;
}
async function seed(store: ReturnType<typeof setup>) {
    await store.getState().hydrate("owner");
    store.getState().replaceProjectsFromServer([base]);
    store.getState().startSync("owner");
    await flush();
}

test("a local edit never persists a new document with a clean sync marker", async () => {
    const disk = memory();
    const response = Promise.withResolvers<CanvasProjectDetail>();
    const store = setup(disk.storage, async () => response.promise);
    await seed(store);
    store.getState().setProjectSyncBlocked(base.id, true);
    store.getState().setProjectSyncBlocked(base.id, false);
    store.getState().renameProject(base.id, "draft");
    await flush();
    const drafts = disk.writes.filter((s) => s.projects[0]?.title === "draft");
    assert.ok(drafts.length);
    assert.ok(
        drafts.every((s) => s.projectSync[base.id].dirty || s.projectSync[base.id].pending || s.projectSync[base.id].saving),
        "persisted new draft as clean",
    );
    store.getState().setProjectSyncBlocked(base.id, true);
    response.resolve({ ...base, title: "draft", revision: 2 });
    await flush();
});

test("registers the immutable request on disk before the API can accept it", async () => {
    const disk = memory(),
        started = Promise.withResolvers<void>(),
        response = Promise.withResolvers<CanvasProjectDetail>();
    let submitted: any;
    const store = setup(disk.storage, async (_id, input, trace) => {
        submitted = { input, trace };
        started.resolve();
        return response.promise;
    });
    await seed(store);
    store.getState().renameProject(base.id, "A");
    await started.promise;
    try {
        const request = (disk.read()!.state as CanvasStore).projectSync[base.id].unknownRequest;
        assert.ok(request, "API ran before its request identity was persisted");
        assert.deepEqual(request.document, submitted.input.document);
        assert.equal(request.trace.requestId, submitted.trace.requestId);
        assert.equal(request.baseRevision, submitted.input.revision);
    } finally {
        response.resolve({ ...base, title: "A", revision: 2 });
        await flush();
    }
});

test("a fresh store replays accepted A before saving edits B, without a second revision for A", async () => {
    const disk = memory(),
        started = Promise.withResolvers<void>();
    let accepted: { input: any; trace: any } | undefined;
    const first = setup(disk.storage, async (_id, input, trace) => {
        accepted = structuredClone({ input, trace });
        started.resolve();
        return new Promise(() => {});
    });
    await seed(first);
    first.getState().renameProject(base.id, "A");
    await started.promise;
    const captured = disk.read();
    const restoredDisk = memory();
    await restoredDisk.storage.setItem("ignored", captured!);
    const replayStarted = Promise.withResolvers<void>(),
        replayReply = Promise.withResolvers<void>(),
        final = Promise.withResolvers<void>();
    const calls: any[] = [];
    const restored = setup(restoredDisk.storage, async (_id, input, trace) => {
        calls.push(structuredClone({ input, trace }));
        if (calls.length === 1) {
            replayStarted.resolve();
            await replayReply.promise;
            assert.deepEqual(input, accepted!.input);
            assert.equal(trace!.requestId, accepted!.trace.requestId);
            return { ...base, ...input, revision: 2 };
        }
        assert.equal(input.revision, 2);
        assert.equal(input.title, "B");
        final.resolve();
        return { ...base, ...input, revision: 3 };
    });
    await restored.getState().hydrate("owner");
    restored.getState().startSync("owner");
    await replayStarted.promise;
    restored.getState().renameProject(base.id, "B");
    await flush();
    assert.equal(calls.length, 1);
    replayReply.resolve();
    await final.promise;
    await flush();
    assert.equal(restored.getState().projects[0].title, "B");
    assert.equal(restored.getState().projectSync[base.id].serverRevision, 3);
    assert.equal(restored.getState().projectSync[base.id].unknownRequest, undefined);
});

test("a definitely rejected request releases its identity for a corrected draft", async () => {
    const disk = memory(),
        rejected = Promise.withResolvers<void>(),
        completed = Promise.withResolvers<void>();
    const ids: string[] = [],
        titles: string[] = [];
    const store = setup(disk.storage, async (_id, input, trace) => {
        ids.push(trace!.requestId);
        titles.push(input.title);
        if (ids.length === 1) {
            rejected.resolve();
            throw new ApiRequestError("invalid input", 400, 1, { code: "canvas_save_rejected" });
        }
        completed.resolve();
        return { ...base, ...input, revision: 2 };
    });
    await seed(store);
    store.getState().renameProject(base.id, "invalid");
    await rejected.promise;
    await flush();
    assert.equal(store.getState().projectSync[base.id].unknownRequest, undefined);
    store.getState().renameProject(base.id, "corrected");
    await completed.promise;
    await flush();
    assert.notEqual(ids[0], ids[1]);
    assert.deepEqual(titles, ["invalid", "corrected"]);
    assert.equal(store.getState().projectSync[base.id].serverRevision, 2);
});

test("the registration barrier excludes later writes and serializes competing save entries", async () => {
    const disk = memory(),
        registered = Promise.withResolvers<void>(),
        allowRegistration = Promise.withResolvers<void>();
    const later = Promise.withResolvers<void>(),
        allowLater = Promise.withResolvers<void>(),
        started = Promise.withResolvers<void>();
    let held = false,
        calls = 0;
    const storage = {
        ...disk.storage,
        setItem: async (key: string, value: StorageValue<CanvasStore>) => {
            const s = value.state as CanvasStore;
            if (s.projectSync[base.id]?.unknownRequest && !held) {
                held = true;
                registered.resolve();
                await allowRegistration.promise;
            }
            if (s.projects[0]?.title === "later") {
                later.resolve();
                await allowLater.promise;
            }
            await disk.storage.setItem(key, value);
        },
    };
    const response = Promise.withResolvers<CanvasProjectDetail>();
    const store = setup(storage, async () => {
        calls++;
        started.resolve();
        return response.promise;
    });
    await seed(store);
    store.getState().renameProject(base.id, "A");
    await registered.promise;
    const retries = [store.getState().retryPendingSaves(), store.getState().retryPendingSaves()];
    assert.equal(calls, 0);
    store.getState().renameProject(base.id, "later");
    allowRegistration.resolve();
    await started.promise;
    await later.promise;
    assert.equal(calls, 1, "waiting on subsequent edits starved the request or started duplicates");
    store.getState().setProjectSyncBlocked(base.id, true);
    allowLater.resolve();
    response.resolve({ ...base, revision: 2, title: "A" });
    await Promise.all(retries);
    await flush();
});

test("registration write failure never calls the server, and explicit retry keeps its ID", async () => {
    const disk = memory();
    let fail = true,
        calls = 0,
        id: string | undefined;
    const failure = Promise.withResolvers<void>(),
        success = Promise.withResolvers<void>();
    const storage = {
        ...disk.storage,
        setItem: async (key: string, value: StorageValue<CanvasStore>) => {
            const request = (value.state as CanvasStore).projectSync[base.id]?.unknownRequest;
            if (request && fail) {
                id = request.trace.requestId;
                throw new Error("disk full");
            }
            return disk.storage.setItem(key, value);
        },
    };
    const store = setup(storage, async (_id, input, trace) => {
        calls++;
        assert.equal(trace!.requestId, id);
        success.resolve();
        return { ...base, ...input, revision: 2 };
    });
    await seed(store);
    const unsub = store.subscribe((s) => {
        if (s.projectSync[base.id]?.error === "disk full") failure.resolve();
    });
    store.getState().renameProject(base.id, "A");
    await failure.promise;
    await flush();
    assert.equal(calls, 0);
    assert.equal(store.getState().projects[0].title, "A");
    fail = false;
    await store.getState().retryPendingSaves();
    await success.promise;
    await flush();
    unsub();
    assert.equal(calls, 1);
});

test("failed acknowledgement persistence retains A and newer draft B without sending B", async () => {
    const disk = memory(),
        started = Promise.withResolvers<void>(),
        reply = Promise.withResolvers<void>(),
        failure = Promise.withResolvers<void>();
    let fail = true;
    const calls: any[] = [];
    const storage = {
        ...disk.storage,
        setItem: async (key: string, value: StorageValue<CanvasStore>) => {
            const sync = (value.state as CanvasStore).projectSync[base.id];
            if (sync?.serverRevision === 2 && !sync.unknownRequest && fail) throw new Error("ack disk failure");
            return disk.storage.setItem(key, value);
        },
    };
    const store = setup(storage, async (_id, input, trace) => {
        calls.push({ input, trace });
        if (calls.length === 1) {
            started.resolve();
            await reply.promise;
        }
        return { ...base, ...input, revision: input.revision + 1 };
    });
    await seed(store);
    const unsub = store.subscribe((s) => {
        if (s.projectSync[base.id]?.error === "ack disk failure") failure.resolve();
    });
    store.getState().renameProject(base.id, "A");
    await started.promise;
    store.getState().renameProject(base.id, "B");
    reply.resolve();
    await failure.promise;
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(store.getState().projects[0].title, "B");
    assert.equal(store.getState().projectSync[base.id].serverRevision, 1);
    assert.equal(store.getState().projectSync[base.id].unknownRequest?.trace.requestId, calls[0].trace.requestId);
    fail = false;
    await store.getState().retryPendingSaves();
    await flush();
    await flush();
    assert.equal(calls[1].trace.requestId, calls[0].trace.requestId);
    assert.equal(calls[1].input.title, "A");
    store.getState().setProjectSyncBlocked(base.id, true);
    unsub();
});

test("loss of editor ownership while persistence waits prevents sending", async () => {
    const disk = memory(),
        blocked = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
    let calls = 0;
    const storage = {
        ...disk.storage,
        setItem: async (key: string, value: StorageValue<CanvasStore>) => {
            if ((value.state as CanvasStore).projectSync[base.id]?.unknownRequest) {
                blocked.resolve();
                await release.promise;
            }
            return disk.storage.setItem(key, value);
        },
    };
    const store = setup(storage, async () => {
        calls++;
        return base;
    });
    await seed(store);
    store.getState().renameProject(base.id, "A");
    await blocked.promise;
    store.getState().setProjectSyncBlocked(base.id, true);
    release.resolve();
    await flush();
    assert.equal(calls, 0);
    assert.ok(store.getState().projectSync[base.id].unknownRequest);
});

test("old account or writer callbacks cannot acknowledge a new session", async () => {
    for (const change of ["account", "writer"]) {
        const disk = memory(),
            started = Promise.withResolvers<void>(),
            reply = Promise.withResolvers<CanvasProjectDetail>();
        const store = setup(disk.storage, async () => {
            started.resolve();
            return reply.promise;
        });
        await seed(store);
        store.getState().renameProject(base.id, "A");
        await started.promise;
        if (change === "account") store.getState().startSync("other-owner");
        else store.getState().setProjectSyncBlocked(base.id, true);
        reply.resolve({ ...base, title: "A", revision: 2 });
        await flush();
        assert.equal(store.getState().projectSync[base.id].serverRevision, 1);
        assert.ok(store.getState().projectSync[base.id].unknownRequest);
    }
});

test("legacy interrupted saving revalidates its baseline instead of inventing an old request", async () => {
    const disk = memory();
    let calls = 0,
        reads = 0;
    const initial = setup(disk.storage, async () => base);
    await seed(initial);
    initial.setState((s) => ({ projectSync: { ...s.projectSync, [base.id]: { ...s.projectSync[base.id], saving: true } } }));
    await flush();
    const stored = disk.read()!;
    const store = setup(
        { ...disk.storage, getItem: async () => stored },
        async () => {
            calls++;
            return base;
        },
        {
            get: async () => {
                reads++;
                return { ...base, revision: 2 };
            },
        },
    );
    await store.getState().hydrate("owner");
    const conflict = Promise.withResolvers<void>();
    store.subscribe((s) => {
        if (s.projectSync[base.id]?.conflict) conflict.resolve();
    });
    store.getState().startSync("owner");
    await conflict.promise;
    assert.equal(calls, 0);
    assert.ok(reads > 0);
    assert.equal(store.getState().projectSync[base.id].conflict, true);
    assert.equal(store.getState().projects[0].title, "base");
});

test("malformed snapshots remain visible as recovery errors without any PUT", async () => {
    const disk = memory();
    let calls = 0;
    const initial = setup(disk.storage, async () => base);
    await seed(initial);
    initial.setState((s) => ({ projectSync: { ...s.projectSync, [base.id]: { ...s.projectSync[base.id], unknownRequest: { trace: { requestId: "broken" } } as never } } }));
    await flush();
    const store = setup({ ...disk.storage, getItem: async () => disk.read() }, async () => {
        calls++;
        return base;
    });
    await store.getState().hydrate("owner");
    store.getState().startSync("owner");
    await flush();
    assert.equal(calls, 0);
    assert.equal(store.getState().projectSync[base.id].pauseReason, "recovery");
    assert.match(store.getState().projectSync[base.id].error!, /损坏/);
});

test("permission failures and ambiguous rejections retain the original identity", async () => {
    for (const error of [new ApiRequestError("expired", 401, 1), new ApiRequestError("unknown", 400, 1), new ApiRequestError("mismatch", 400, 1, { code: "canvas_save_request_mismatch" })]) {
        const disk = memory(),
            failed = Promise.withResolvers<void>();
        const store = setup(disk.storage, async () => {
            failed.resolve();
            throw error;
        });
        await seed(store);
        store.getState().renameProject(base.id, "A");
        await failed.promise;
        await flush();
        assert.ok(store.getState().projectSync[base.id].unknownRequest);
        store.getState().setProjectSyncBlocked(base.id, true);
    }
});

test("a queued delete first confirms an unknown PUT and uses the acknowledged revision", async () => {
    const disk = memory(),
        failed = Promise.withResolvers<void>(),
        deleted = Promise.withResolvers<void>();
    const calls: string[] = [];
    let attempt = 0;
    const store = setup(
        disk.storage,
        async (_id, input) => {
            calls.push("put:" + input.revision);
            if (++attempt === 1) {
                failed.resolve();
                throw new Error("lost");
            }
            return { ...base, ...input, revision: 2 };
        },
        {
            delete: async (_id, revision) => {
                calls.push("delete:" + revision);
                deleted.resolve();
            },
        },
    );
    await seed(store);
    store.getState().renameProject(base.id, "A");
    await failed.promise;
    await flush();
    store.getState().deleteProjects([base.id]);
    await store.getState().retryPendingSaves();
    await deleted.promise;
    await flush();
    assert.deepEqual(calls, ["put:1", "put:1", "delete:2"]);
    assert.equal(store.getState().openProject(base.id), null);
});

test("leaving an editor fences a pending save and later library edits can resume it", async () => {
    const disk = memory(),
        entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
    let calls = 0;
    const storage = {
        ...disk.storage,
        setItem: async (key: string, value: StorageValue<CanvasStore>) => {
            if (value.state.projectSync[base.id]?.unknownRequest) {
                entered.resolve();
                await release.promise;
            }
            return disk.storage.setItem(key, value);
        },
    };
    const store = setup(storage, async (_id, input) => {
        calls++;
        return { ...base, ...input, revision: input.revision + 1 };
    });
    await seed(store);
    store.getState().renameProject(base.id, "A");
    await entered.promise;
    store.getState().releaseProjectEditor(base.id);
    release.resolve();
    await flush();
    await flush();
    assert.equal(calls, 0);
    assert.ok(store.getState().projectSync[base.id].unknownRequest);
    assert.equal(store.getState().blockedProjectSync[base.id], undefined, "library actions remain available");
    await store.getState().retryPendingSaves();
    assert.equal(calls, 0, "online callback cannot resume a released editor");
    const saved = Promise.withResolvers<void>();
    store.subscribe((s) => {
        if (s.projectSync[base.id]?.serverRevision === 3) saved.resolve();
    });
    store.getState().renameProject(base.id, "B");
    await saved.promise;
    assert.equal(calls, 2);
    store.getState().releaseProjectEditor(base.id);
});

test("failed rejection persistence keeps the old identity and cannot start a corrected PUT", async () => {
    const disk = memory(),
        failed = Promise.withResolvers<void>();
    let calls = 0;
    const storage = {
        ...disk.storage,
        setItem: async (key: string, value: StorageValue<CanvasStore>) => {
            const sync = value.state.projectSync[base.id];
            if (sync?.pauseReason === "rejected" && !sync.unknownRequest) throw new Error("rejection disk failure");
            return disk.storage.setItem(key, value);
        },
    };
    const store = setup(storage, async () => {
        calls++;
        throw new ApiRequestError("invalid reference", 400, 1, { code: "canvas_save_rejected" });
    });
    await seed(store);
    store.subscribe((s) => {
        if (s.projectSync[base.id]?.error === "rejection disk failure") failed.resolve();
    });
    store.getState().renameProject(base.id, "A");
    await failed.promise;
    await flush();
    assert.equal(calls, 1);
    assert.ok(store.getState().projectSync[base.id].unknownRequest);
    assert.equal(store.getState().projectSync[base.id].serverRevision, 1);
    store.getState().releaseProjectEditor(base.id);
});
