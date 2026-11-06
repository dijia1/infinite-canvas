import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowDraftWriter } from "./workflow-draft-writer";
import { readWorkflowDraft } from "./workflow-editor-state";
import { emptyWorkflowGraph } from "./workflow-graph";

const draft = (name: string) => ({ revision: 1, document: { name, graph: emptyWorkflowGraph() } });
function storage() {
    const values = new Map<string, string>();
    let writes = 0;
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { writes++; values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, get writes() { return writes; } };
}

test("coalesces draft persistence while recovery immediately sees the newest graph", () => {
    const store = storage();
    const writer = createWorkflowDraftWriter(store, "owner", "coalesce", 60_000);
    writer.schedule(draft("first"));
    writer.schedule(draft("latest"));
    assert.equal(store.writes, 0);
    assert.equal(readWorkflowDraft(store, "owner", "coalesce")?.document.name, "latest");
    writer.flush();
    writer.flush();
    assert.equal(store.writes, 1);
    assert.match(store.getItem("infinite-canvas:workflow-draft:owner:coalesce")!, /latest/);
});

test("persists after the debounce and cannot resurrect a draft cleared after save", async () => {
    const store = storage();
    const writer = createWorkflowDraftWriter(store, "owner", "timer", 1);
    writer.schedule(draft("first"));
    writer.schedule(draft("latest"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(store.writes, 1);
    writer.schedule(draft("pending"));
    writer.clear();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(store.writes, 1);
    assert.equal(readWorkflowDraft(store, "owner", "timer"), undefined);
});

test("flushing a departing scope leaves another owner's draft independent", () => {
    const store = storage();
    const first = createWorkflowDraftWriter(store, "owner-a", "flow", 60_000);
    const second = createWorkflowDraftWriter(store, "owner-b", "flow", 60_000);
    first.schedule(draft("A")); second.schedule(draft("B"));
    first.flush(); second.flush();
    assert.equal(readWorkflowDraft(store, "owner-a", "flow")?.document.name, "A");
    assert.equal(readWorkflowDraft(store, "owner-b", "flow")?.document.name, "B");
});
