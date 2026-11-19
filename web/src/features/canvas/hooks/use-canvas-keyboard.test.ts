import assert from "node:assert/strict";
import test from "node:test";

import { hookHarness, sourceModule } from "@/test-utils/source-component";
import type { useCanvasKeyboard } from "./use-canvas-keyboard";

test("canvas receives native clipboard events and leaves text selection and editors to the browser", () => {
    const h = hookHarness();
    let selection = false;
    const editable = {};
    const document = { activeElement: null as object | null };
    const window = Object.assign(new EventTarget(), { getSelection: () => ({ isCollapsed: !selection }) });
    const { useCanvasKeyboard: useKeyboard } = sourceModule<{ useCanvasKeyboard: typeof useCanvasKeyboard }>(new URL("./use-canvas-keyboard.ts", import.meta.url),
        { react: h.hooks, "@/lib/editable-target": { isEditableTarget: (target: unknown) => target === editable } },
        { document, window, HTMLSelectElement: class HTMLSelectElement {} },
    );
    const calls: string[] = [];
    const noop = () => {};
    const render = (readOnly = false) => h.render(() => useKeyboard({
        readOnly, undo: noop, redo: noop, selectAll: noop, deleteSelection: noop, escape: noop,
        copy: () => { calls.push("copy"); return true; },
        paste: () => { calls.push("paste"); return true; },
    }));
    const send = (type: string, attrs: object = {}) => {
        const event = Object.assign(new Event(type, { cancelable: true }), attrs);
        window.dispatchEvent(event);
        return event.defaultPrevented;
    };
    render();
    for (const key of ["c", "v"]) assert.equal(send("keydown", { key, metaKey: true }), false);
    assert.equal(send("copy", { clipboardData: {} }), true);
    assert.equal(send("paste", { clipboardData: {} }), true);
    document.activeElement = editable;
    assert.equal(send("copy", { clipboardData: {} }), false);
    assert.equal(send("paste", { clipboardData: {} }), false);
    document.activeElement = null;
    selection = true;
    assert.equal(send("copy", { clipboardData: {} }), false);
    assert.equal(send("paste", { clipboardData: {} }), false);
    selection = false;
    const drawerPaste = Object.assign(new Event("paste", { cancelable: true }), { clipboardData: {} });
    drawerPaste.preventDefault();
    window.dispatchEvent(drawerPaste);
    render(true);
    assert.equal(send("paste", { clipboardData: {} }), false);
    h.unmount();
    assert.deepEqual(calls, ["copy", "paste"]);
});
