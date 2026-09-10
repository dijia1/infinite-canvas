import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness, sourceModule, deferred, flushAsync } from "@/test-utils/source-component";
import type { CanvasProject } from "../stores/use-canvas-store";
import type { useCanvasProjectDetail } from "./use-canvas-project-detail";

const project = (id: string): CanvasProject => ({ id, title: id, createdAt: "2026-09-01", updatedAt: "2026-09-01", nodes: [], connections: [], maskResources: {}, backgroundMode: "lines", showImageInfo: false, viewport: { x: 10, y: 20, k: 1.2 } });
function environment(load: (id: string) => Promise<CanvasProject>) {
    const harness = hookHarness();
    const store = { ensureProjectDetail: load, openProject: () => null };
    const hook = sourceModule<{ useCanvasProjectDetail: typeof useCanvasProjectDetail }>(new URL("./use-canvas-project-detail.ts", import.meta.url), {
        react: harness.hooks,
        "../stores/use-canvas-store": { useCanvasStore: (selector: (state: typeof store) => unknown) => selector(store) },
    });
    return { harness, render: (id = "a", scope = "user", ready = true) => harness.render(() => hook.useCanvasProjectDetail(id, ready, scope, 0)) };
}

test("a summary-only editor waits for complete detail instead of initializing empty content", async () => {
    const response = deferred<CanvasProject>();
    const e = environment(async () => response.promise);
    assert.equal(e.render().loading, true);
    assert.equal(e.render().project, null);
    response.resolve(project("a"));
    await flushAsync();
    assert.equal(e.render().project?.id, "a");
    assert.deepEqual(e.render().project?.viewport, { x: 10, y: 20, k: 1.2 });
    assert.equal(e.render().loading, false);
    e.harness.unmount();
});

test("detail failure is visible and retry fetches again without creating an empty canvas", async () => {
    let calls = 0;
    const e = environment(async () => {
        if (++calls === 1) throw new Error("network unavailable");
        return project("a");
    });
    e.render();
    await flushAsync();
    const failed = e.render();
    assert.equal(failed.project, null);
    assert.equal(failed.error, "network unavailable");
    failed.retry();
    e.render();
    await flushAsync();
    assert.equal(e.render().project?.id, "a");
    assert.equal(e.render().error, null);
    assert.equal(calls, 2);
    e.harness.unmount();
});

test("late detail results cannot appear after switching canvas or account", async () => {
    const old = deferred<CanvasProject>();
    const e = environment(async (id) => (id === "a" ? old.promise : project(id)));
    e.render("a");
    e.render("b", "another-user");
    await flushAsync();
    assert.equal(e.render("b", "another-user").project?.id, "b");
    old.resolve(project("a"));
    await flushAsync();
    assert.equal(e.render("b", "another-user").project?.id, "b");
    e.harness.unmount();
    assert.equal(e.harness.postUnmountUpdates, 0);
});

test("editor loading waits for local hydration and bootstrap readiness", async () => {
    let calls = 0;
    const e = environment(async () => {
        calls++;
        return project("a");
    });
    assert.equal(e.render("a", "user", false).project, null);
    await flushAsync();
    assert.equal(calls, 0);
    e.render();
    await flushAsync();
    assert.equal(calls, 1);
    e.harness.unmount();
});
