import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasDocumentPublisher, isCanvasDocumentPublicationCurrent, type CanvasEditorDocument } from "./use-canvas-document-sync";
import { CanvasNodeType } from "../types";

const baseline = (): CanvasEditorDocument => ({ nodes: [], connections: [], maskResources: {}, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } });
const node = (id: string) => ({ id, type: CanvasNodeType.Text, title: id, width: 100, height: 100, position: { x: 0, y: 0 }, metadata: { content: id } });
function setup() {
    const writes: CanvasEditorDocument[] = [];
    const states: boolean[] = [];
    const timers = new Map<number, () => void>();
    let sequence = 0;
    let current = true;
    const publisher = createCanvasDocumentPublisher({
        publish: (next) => writes.push(next), isCurrent: () => current, onPendingChange: (pending) => states.push(pending),
        schedule: (fn) => { timers.set(++sequence, fn); return sequence as unknown as ReturnType<typeof setTimeout>; },
        clear: (id) => { timers.delete(id as unknown as number); },
    });
    return { publisher, writes, states, timers, obsolete: () => { current = false; }, tick: () => { for (const fn of [...timers.values()]) fn(); } };
}

test("coalesces full documents without delaying the original flush during continuous edits", () => {
    const { publisher, writes, states, timers, tick } = setup();
    const initial = baseline();
    publisher.capture(initial, initial);
    assert.equal(timers.size, 0);
    publisher.capture({ ...initial, nodes: [node("A")] }, initial);
    const firstTimer = [...timers.keys()];
    const latest = { ...initial, nodes: [node("A"), node("B")], connections: [{ id: "AB", fromNodeId: "A", toNodeId: "B" }], viewport: { x: 32, y: 56, k: .76 } };
    publisher.capture(latest, initial);
    assert.deepEqual([...timers.keys()], firstTimer);
    tick();
    assert.deepEqual(writes, [latest]);
    assert.deepEqual(states, [true, false]);
    publisher.capture({ ...latest, viewport: { x: 90, y: 56, k: 1.58 } }, initial);
    tick();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].nodes, latest.nodes);
});

test("leaving flushes only the latest pending document, including the last gesture", () => {
    const { publisher, writes, tick } = setup();
    const initial = baseline();
    const latest = { ...initial, nodes: [node("A"), node("B")] };
    publisher.capture(latest, initial);
    publisher.flushViewport({ x: 120, y: -5, k: 1.43 });
    publisher.flush();
    tick();
    assert.deepEqual(writes, [{ ...latest, viewport: { x: 120, y: -5, k: 1.43 } }]);
    assert.equal(publisher.pending, false);
});

test("returning to the published document cancels the pending write", () => {
    const { publisher, writes, tick } = setup();
    const initial = baseline();
    publisher.capture({ ...initial, nodes: [node("A")] }, initial);
    publisher.capture(initial, initial);
    tick();
    assert.deepEqual(writes, []);
    assert.equal(publisher.pending, false);
});

test("scope changes or read-only takeover invalidate a queued publication", () => {
    const { publisher, writes, tick, obsolete } = setup();
    const initial = baseline();
    publisher.capture({ ...initial, nodes: [node("A")] }, initial);
    obsolete();
    publisher.flushViewport({ x: 70, y: 90, k: 1 });
    tick();
    assert.deepEqual(writes, []);
    assert.equal(publisher.pending, true);
    publisher.cancel();
    assert.equal(publisher.pending, false);
});

test("edits after ownership loss remain available to local recovery", () => {
    const { publisher, writes, obsolete } = setup();
    const initial = baseline();
    publisher.capture({ ...initial, nodes: [node("A")] }, initial);
    obsolete();
    const latest = { ...initial, nodes: [node("A"), node("B")] };
    publisher.capture(latest, initial);
    publisher.flush();
    assert.deepEqual(publisher.getPendingDocument(), latest);
    assert.deepEqual(writes, []);
    publisher.cancel();
});

test("adopting a confirmed conversion baseline does not publish another document", () => {
    const { publisher, writes, tick } = setup();
    const initial = baseline(); publisher.capture(initial, initial);
    const converted = { ...initial, nodes: [node("private-copy")] };
    publisher.acceptBaseline(converted); publisher.capture(converted, converted); tick();
    assert.equal(publisher.pending, false); assert.deepEqual(writes, []);
    const edited = { ...converted, nodes: [...converted.nodes, node("new-edit")] };
    publisher.capture(edited, converted); tick(); assert.deepEqual(writes, [edited]);
});


test("a conflict permits local publication, while account, generation and ownership changes fence it", () => {
    const state = {
        syncScope: "owner", canonicalGeneration: 3, readyForCanvasMutations: true,
        blockedProjectSync: {}, projects: [{ id: "canvas" }],
        projectSync: { canvas: { conflict: true } },
    };
    assert.equal(isCanvasDocumentPublicationCurrent(state, "canvas", "owner", 3), true);
    assert.equal(isCanvasDocumentPublicationCurrent({ ...state, syncScope: "other" }, "canvas", "owner", 3), false);
    assert.equal(isCanvasDocumentPublicationCurrent({ ...state, canonicalGeneration: 4 }, "canvas", "owner", 3), false);
    assert.equal(isCanvasDocumentPublicationCurrent({ ...state, blockedProjectSync: { canvas: true } }, "canvas", "owner", 3), false);
});
