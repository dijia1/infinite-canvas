import test from "node:test";
import assert from "node:assert/strict";
import { createVideoResourceManager } from "./video-resource-manager";
const createManager = (options: Parameters<typeof createVideoResourceManager>[0]) => createVideoResourceManager({ cachePoster: (_id, load) => load(), ...options });
const access = (url = "video") => ({ mediaId: "m", url, previewUrl: "https://oss.test/v?x-oss-process=video%2Fsnapshot", expiresAt: new Date(Date.now() + 3600000).toISOString(), bytes: 1, contentType: "video/mp4", width: 10, height: 10, duration: 2 });
test("shares concurrent access and one consumer release does not abort another", async () => {
    let calls = 0;
    let finish!: (value: ReturnType<typeof access>) => void;
    let signal!: AbortSignal;
    const manager = createManager({
        loadAccess: (_id, s) => {
            calls++;
            signal = s;
            return new Promise((r) => (finish = r));
        },
        graceMs: 0,
    });
    const a = manager.acquire("m"),
        b = manager.acquire("m");
    const first = a.getAccess(),
        second = b.getAccess();
    a.release();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(signal.aborted, false);
    finish(access());
    assert.equal((await first).url, "video");
    assert.equal((await second).url, "video");
    assert.equal(calls, 1);
    b.release();
    manager.dispose();
});
test("session reset prevents stale results and aborts outstanding requests", async () => {
    let finish!: (value: ReturnType<typeof access>) => void;
    let signal!: AbortSignal;
    const manager = createManager({
        loadAccess: (_id, s) => {
            signal = s;
            return new Promise((r) => (finish = r));
        },
    });
    const a = manager.acquire("m");
    const request = a.getAccess();
    manager.resetSession();
    assert.equal(signal.aborted, true);
    finish(access());
    await assert.rejects(request);
    a.release();
    manager.dispose();
});
test("deduplicates recovery and reuses newly refreshed URL for old failures", async () => {
    let calls = 0;
    const manager = createManager({ loadAccess: async () => access(`video-${++calls}`) });
    const a = manager.acquire("m"),
        b = manager.acquire("m");
    await a.getAccess();
    const values = await Promise.all([a.refreshAfterFailure("video-1"), b.refreshAfterFailure("video-1")]);
    assert.equal(values[0].url, "video-2");
    assert.equal(values[1].url, "video-2");
    assert.equal(calls, 2);
    manager.dispose();
});
test("poster bytes are shared, failures negatively cached and released on disposal", async () => {
    let downloads = 0,
        revoked = 0;
    const manager = createManager({
        loadAccess: async () => access(),
        loadPoster: async () => {
            downloads++;
            return new Blob(["jpg"], { type: "image/jpeg" });
        },
        createURL: () => "blob:poster",
        revokeURL: () => revoked++,
    });
    const a = manager.acquire("m"),
        b = manager.acquire("m");
    assert.equal(await a.getPoster(), "blob:poster");
    assert.equal(await b.getPoster(), "blob:poster");
    assert.equal(downloads, 1);
    manager.dispose();
    assert.equal(revoked, 1);
    let failures = 0;
    const failed = createManager({
        loadAccess: async () => access(),
        loadPoster: async () => {
            failures++;
            throw Error("bad snapshot");
        },
    });
    const c = failed.acquire("m");
    assert.equal(await c.getPoster(), undefined);
    assert.equal(await c.getPoster(), undefined);
    assert.equal(failures, 1);
    failed.dispose();
});
test("last consumer aborts pending request after grace period", async () => {
    let signal!: AbortSignal;
    const manager = createManager({
        loadAccess: (_id, s) => {
            signal = s;
            return new Promise((_r, reject) => s.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
        },
        graceMs: 0,
    });
    const a = manager.acquire("m");
    const p = a.getAccess().catch(() => undefined);
    a.release();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(signal.aborted, true);
    await p;
    manager.dispose();
});

test("expired access refreshes without changing a valid shared address", async () => {
    let calls = 0;
    const manager = createManager({ loadAccess: async () => ({ ...access(`url-${++calls}`), expiresAt: new Date(Date.now() + (calls === 1 ? 1000 : 3600000)).toISOString() }) });
    const lease = manager.acquire("m");
    assert.equal((await lease.getAccess()).url, "url-1");
    assert.equal((await lease.getAccess()).url, "url-2");
    assert.equal((await lease.getAccess()).url, "url-2");
    assert.equal(calls, 2);
    manager.dispose();
});

test("poster budget evicts idle resources but preserves active resources", async () => {
    const revoked: string[] = [];
    let next = 0;
    const manager = createManager({ maxBytes: 3, loadAccess: async () => access(), loadPoster: async () => new Blob(["jpg"]), createURL: () => `blob:${++next}`, revokeURL: (url) => revoked.push(url) });
    const first = manager.acquire("a");
    assert.equal(await first.getPoster(), "blob:1");
    const second = manager.acquire("b");
    assert.equal(await second.getPoster(), undefined);
    assert.deepEqual(revoked, []);
    first.release();
    assert.equal(await second.getPoster(), "blob:2");
    assert.deepEqual(revoked, ["blob:1"]);
    manager.dispose();
});

test("poster failures expire and idle resources are eventually released", async () => {
    let calls = 0;
    let revoked = 0;
    const manager = createManager({
        failureMs: 1,
        idleMs: 5,
        loadAccess: async () => access(),
        loadPoster: async () => {
            if (++calls === 1) throw Error("snapshot failed");
            return new Blob(["jpg"]);
        },
        createURL: () => "blob:poster",
        revokeURL: () => revoked++,
    });
    const lease = manager.acquire("m");
    assert.equal(await lease.getPoster(), undefined);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await lease.getPoster(), "blob:poster");
    lease.release();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(revoked, 1);
    manager.dispose();
});
