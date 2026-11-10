import test from "node:test";
import assert from "node:assert/strict";
import { hookHarness, sourceModule, elements as matchingElements } from "@/test-utils/source-component";
import type { ImageInputSorter } from "./image-input-sorter";
import { imageInputLabel, moveInputKey } from "@/lib/generation-input-order";
import { canvasThemes } from "@/lib/canvas-theme";

const elements = (tree: unknown) => matchingElements(tree, () => true);

function setup(readOnly = false) {
    const h = hookHarness();
    const calls: string[][] = [];
    const { ImageInputSorter: Sorter } = sourceModule<{ ImageInputSorter: typeof ImageInputSorter }>(new URL("./image-input-sorter.tsx", import.meta.url), {
        react: h.hooks,
        "lucide-react": { ArrowLeft: "i", ArrowRight: "i", GripVertical: "i" },
        antd: { Button: "button" },
        "@/lib/generation-input-order": { imageInputLabel, moveInputKey },
    }, { Node: class {} });
    const render = () => h.render(() => Sorter({ theme: canvasThemes.dark, readOnly, items: ["a", "b", "c"].map(key => ({ key, preview: <img alt={key} /> })), onReorder: keys => calls.push(keys) }));
    const root = () => render() as React.ReactElement<Record<string, any>>;
    const cards = () => elements(render()).filter(el => el.props["data-input-sort-key"]);
    const event = (x = 0) => ({ clientX: x, preventDefault() {}, stopPropagation() {}, dataTransfer: { effectAllowed: "", dropEffect: "", setData() {} }, currentTarget: { scrollLeft: 0, getBoundingClientRect: () => ({ left: 0, right: 320 }), querySelectorAll: () => [0, 1, 2].map(i => ({ getBoundingClientRect: () => ({ left: i * 104, width: 96 }) })) } });
    return { calls, root, cards, event, h };
}

test("cross-position drop inserts the image once and displays matching numbered labels", () => {
    const s = setup();
    assert.deepEqual(s.cards().map(card => card.props["aria-label"]), ["图1，可拖动排序", "图2，可拖动排序", "图3，可拖动排序"]);
    s.cards()[2]!.props.onDragStart(s.event());
    s.root().props.onDragOver(s.event(15));
    assert.equal(s.calls.length, 0);
    s.root().props.onDrop(s.event(15));
    assert.deepEqual(s.calls, [["c", "a", "b"]]);
    s.root().props.onDragEnd();
    assert.equal(s.calls.length, 1);
    s.h.unmount();
});

test("cancel, same-position drop and read-only previews cannot change input order", () => {
    const s = setup();
    s.cards()[1]!.props.onDragStart(s.event());
    s.root().props.onDragOver(s.event(130));
    s.root().props.onDrop(s.event(130));
    s.cards()[2]!.props.onDragStart(s.event());
    s.root().props.onDragOver(s.event(5));
    s.root().props.onDragEnd();
    assert.deepEqual(s.calls, []);
    const readonly = setup(true);
    assert.ok(readonly.cards().every(card => card.props.draggable === false));
    assert.ok(elements(readonly.root()).filter(el => el.type === "button").every(button => button.props.disabled));
    s.h.unmount(); readonly.h.unmount();
});

test("arrow moves and dragging to an overflow edge use the same ordered keys", () => {
    const s = setup();
    const forward = elements(s.root()).find(el => el.props["aria-label"] === "将图1后移")!;
    forward.props.onClick();
    assert.deepEqual(s.calls, [["b", "a", "c"]]);
    s.cards()[0]!.props.onDragStart(s.event());
    const e = s.event(315);
    s.root().props.onDragOver(e);
    assert.equal(e.currentTarget.scrollLeft, 12);
    s.root().props.onDrop(e);
    assert.deepEqual(s.calls[1], ["b", "c", "a"]);
    s.h.unmount();
});
