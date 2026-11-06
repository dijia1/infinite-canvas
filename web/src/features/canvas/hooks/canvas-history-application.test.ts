import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasHistoryController } from "./use-canvas-history";

type Document = { nodes: string[]; connections: string[] };

function editor() {
    let rendered: Document = { nodes: ["A"], connections: [] };
    const applications: number[] = [];
    const timers = new Map<number, () => void>();
    let timer = 0;
    const history = createCanvasHistoryController<Document>({
        applySnapshot: (snapshot, applicationId) => {
            applications.push(applicationId);
            // Canvas normalizes restored nodes, which creates a different array.
            rendered = { ...snapshot, nodes: snapshot.nodes.map((node) => node) };
            return rendered;
        },
        isSameSnapshot: (a, b) => a.nodes === b.nodes && a.connections === b.connections,
        schedule: (callback) => { timers.set(++timer, callback); return timer; },
        clear: (id) => { timers.delete(id as number); },
    });
    history.replaceBaseline(rendered);
    const commit = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); };
    const change = (nodes: string[], connections: string[] = []) => {
        rendered = { nodes, connections };
        history.observe(rendered);
        commit();
    };
    return { history, applications, change, commit, read: () => rendered, merge: (node: string) => { rendered = { ...rendered, nodes: [...rendered.nodes, node] }; } };
}

test("normalizing restored nodes does not leave applying stuck or create a duplicate undo entry", () => {
    const e = editor();
    e.change(["A", "config"]);
    e.history.undo();
    assert.equal(typeof e.applications.at(-1), "number", "history must identify the application it commits");
    e.history.completeApplication(e.applications.at(-1)!);
    e.history.observe(e.read());
    e.commit();
    assert.equal(e.history.isApplyingRef.current, false);
    assert.equal(e.history.canUndo, false);
    assert.equal(e.history.canRedo, true);
    e.history.redo();
    e.history.completeApplication(e.applications.at(-1)!);
    e.change(["A", "config", "B"], ["A-config"]);
    e.history.undo();
    assert.deepEqual(e.read().nodes, ["A", "config"]);
});

test("an old application acknowledgement cannot finish a newer undo or redo", () => {
    const e = editor();
    e.change(["A", "B"]);
    e.history.undo();
    const first = e.applications.at(-1)!;
    e.history.redo();
    const second = e.applications.at(-1)!;
    assert.notEqual(first, second);
    e.history.completeApplication(first);
    assert.equal(e.history.isApplyingRef.current, true);
    e.history.completeApplication(second);
    assert.equal(e.history.isApplyingRef.current, false);
});

test("a result merged before history acknowledgement remains editable and retained", () => {
    const e = editor();
    e.change(["A", "pending-result"]);
    e.history.undo();
    e.history.redo();
    e.merge("uploaded-result");
    assert.equal(typeof e.applications.at(-1), "number", "history must identify the application it commits");
    e.history.completeApplication(e.applications.at(-1)!);
    e.history.observe(e.read());
    e.commit();
    assert.equal(e.history.isApplyingRef.current, false);
    assert.deepEqual(e.read().nodes, ["A", "pending-result", "uploaded-result"]);
    assert.deepEqual(e.history.getRetainedHistory().lastHistory?.nodes, ["A", "pending-result", "uploaded-result"]);
});

test("redo cannot discard a newly merged result before its history debounce completes", () => {
    const e = editor();
    e.change(["A", "B"]);
    e.history.undo();
    e.merge("generated-result");
    e.history.completeApplication(e.applications.at(-1)!);
    e.history.observe(e.read());
    e.history.redo();
    assert.deepEqual(e.read().nodes, ["A", "generated-result"]);
    assert.equal(e.history.canRedo, false);
});

for (const reset of ["reset", "replaceBaseline", "dispose"] as const) {
    test(`${reset} invalidates outstanding history applications`, () => {
        const e = editor();
        e.change(["A", "B"]);
        e.history.undo();
        const oldId = e.applications.at(-1)!;
        if (reset === "replaceBaseline") e.history.replaceBaseline({ nodes: ["other"], connections: [] });
        else e.history[reset]();
        assert.equal(e.history.isApplyingRef.current, false);
        e.history.completeApplication(oldId);
        assert.equal(e.history.isApplyingRef.current, false);
    });
}
