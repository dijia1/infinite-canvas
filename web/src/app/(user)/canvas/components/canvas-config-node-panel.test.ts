import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { sourceBehavior } from "@/test-utils/source-behavior";
import { CanvasConfigModelSelect } from "@/components/canvas-config-model-select";
import { CanvasSettingsSelect } from "@/components/canvas-settings-select";
import { canvasThemes } from "@/lib/canvas-theme";
import { defaultConfig, reconcileProviderConfig } from "@/stores/use-config-store";
import { buildGenerationConfig } from "../utils/canvas-generation-utils";
import { CanvasNodeType, type CanvasNodeData } from "../types";

const sourceURL = new URL("./canvas-config-node-panel.tsx", import.meta.url);
function elements(root: ReactNode): ReactElement<Record<string, any>>[] {
    return Children.toArray(root).flatMap((node) => isValidElement<Record<string, any>>(node) ? [node, ...elements(node.props.children)] : []);
}

test("model selector and popup stop canvas pointer events and forward the selected model", () => {
    const selected: string[] = [];
    const Select = CanvasSettingsSelect;
    const component = CanvasConfigModelSelect;
    const root = component({ value: "a", options: [{ id: "a", name: "A" }, { id: "b", name: "B" }], onChange: (id: string) => selected.push(id) })!;
    const select = elements(root).find((node) => node.type === Select)!;
    assert.deepEqual(select.props.options, [{ value: "a", label: "A" }, { value: "b", label: "B" }]);
    select.props.onChange("b");
    assert.deepEqual(selected, ["b"]);
    for (const surface of [root]) {
        let stopped = 0;
        surface.props.onMouseDown({ stopPropagation: () => stopped++ });
        surface.props.onPointerDown({ stopPropagation: () => stopped++ });
        assert.equal(stopped, 2);
    }
});

test("input reordering swaps only matching types and ignores moves past either boundary", () => {
    const inputs = [{ nodeId: "text-a", type: "text" }, { nodeId: "image-a", type: "image" }, { nodeId: "text-b", type: "text" }, { nodeId: "image-b", type: "image" }];
    const patches: unknown[] = [];
    const move = sourceBehavior(sourceURL, {
        inputs, node: { id: "config" },
        onConfigChange: (id: string, patch: unknown) => patches.push([id, patch]),
        message: { success() {} },
    }).named("moveInput");
    move(inputs[0], -1);
    move(inputs[2], 1);
    assert.deepEqual(patches, []);
    move(inputs[0], 1);
    move(inputs[3], -1);
    assert.deepEqual(patches, [
        ["config", { inputOrder: ["text-b", "image-a", "text-a", "image-b"] }],
        ["config", { inputOrder: ["text-a", "image-b", "text-b", "image-a"] }],
    ]);
    for (const name of ["VerticalOrderButtons", "HorizontalOrderButtons"]) {
        const offsets: number[] = [];
        const component = sourceBehavior(sourceURL, { Button: "button", ArrowUp: "i", ArrowDown: "i", ArrowLeft: "i", ArrowRight: "i" }).named(name);
        const buttons = (index: number) => elements(component({ index, total: 3, onMove: (offset: number) => offsets.push(offset) })).filter((node) => node.type === "button");
        assert.deepEqual(buttons(0).map((button) => button.props.disabled), [true, false]);
        assert.deepEqual(buttons(2).map((button) => button.props.disabled), [false, true]);
        buttons(1).forEach((button) => button.props.onClick());
        assert.deepEqual(offsets, [-1, 1]);
    }
});

test("editing an input saves the entered text for that node and clears the editor", () => {
    let editingTextId: string | null = null;
    let editingText = "";
    const saved: unknown[] = [];
    const bindings = {
        setEditingTextId: (id: string | null) => { editingTextId = id; },
        setEditingText: (text: string) => { editingText = text; },
        onTextInputChange: (id: string, text: string) => saved.push([id, text]),
        message: { success() {} },
    };
    const input = { nodeId: "text-a", type: "text", text: "old" };
    const onEdit = sourceBehavior(sourceURL, bindings).named("startTextEdit");
    const card = sourceBehavior(sourceURL, { Button: "button", Edit3: "i", VerticalOrderButtons: "order-buttons" }).named("TextSortCard")({ input, textIndex: 0, textTotal: 1, theme: canvasThemes.light, onEdit, onMove() {} });
    elements(card).find((node) => node.type === "button")!.props.onClick();
    assert.equal(editingTextId, "text-a");
    assert.equal(editingText, "old");
    sourceBehavior(sourceURL, bindings).select((node) => ts.isArrowFunction(node) && ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) && node.parent.parent.name.getText() === "onChange" && node.getText().includes("setEditingText("))({ target: { value: "new prompt" } });
    sourceBehavior(sourceURL, { ...bindings, editingTextId, editingText }).named("saveTextEdit")();
    assert.deepEqual(saved, [["text-a", "new prompt"]]);
    assert.equal(editingTextId, null);
    assert.equal(editingText, "");
});

test("preview editing isolates wheel and outside pointer events and removes listeners on close", () => {
    const listeners = new Map<string, (event: any) => void>();
    const closed: boolean[] = [];
    class Target {}
    const inside = new Target();
    const source = sourceBehavior(sourceURL, {
        previewOpen: true, Node: Target,
        previewContentRef: { current: { contains: (target: unknown) => target === inside } },
        setPreviewOpen: (value: boolean) => closed.push(value),
        document: { addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler), removeEventListener: (name: string) => listeners.delete(name) },
    });
    const dispose = source.select((node) => ts.isArrowFunction(node) && ts.isCallExpression(node.parent) && node.parent.expression.getText() === "useEffect" && node.getText().includes("stopCanvasWheel"))();
    let stops = 0;
    let prevented = 0;
    const event = { target: inside, preventDefault: () => prevented++, stopPropagation: () => stops++ };
    listeners.get("pointerdown")!(event);
    assert.deepEqual(closed, []);
    listeners.get("wheel")!(event);
    listeners.get("pointerdown")!({ ...event, target: new Target() });
    assert.equal(stops, 2);
    assert.equal(prevented, 2);
    assert.deepEqual(closed, [false]);
    dispose();
    assert.equal(listeners.size, 0);
});

test("changing generation mode updates the node used by generation configuration", () => {
    const node: CanvasNodeData = { id: "config", type: CanvasNodeType.Config, title: "Config", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { generationMode: "image" } };
    const source = sourceBehavior(sourceURL, {
        node,
        onConfigChange: (id: string, patch: object) => {
            assert.equal(id, node.id);
            node.metadata = { ...node.metadata, ...patch };
        },
    });
    const change = source.select((node) => ts.isArrowFunction(node) && ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) && node.parent.parent.name.getText() === "onChange" && node.getText().includes("generationMode:"));
    change("video");
    assert.equal(node.metadata?.generationMode, "video");
    const config = { ...defaultConfig, imageProviderId: "old" };
    sourceBehavior(sourceURL, {
        node, config, reconcileProviderConfig,
        aiStatus: { imageModels: [{ id: "new", name: "New", type: "test-provider", imageRequestSchema: { version: "v2", fields: [], maxReferenceImages: 10, supportsMask: false } }] },
        onConfigChange: (_id: string, patch: object) => { node.metadata = { ...node.metadata, ...patch }; },
    }).named("selectImageModel")("new");
    assert.equal(node.metadata?.imageProviderId, "new");
    assert.equal(node.metadata?.imageProviderType, "test-provider");
    assert.equal(node.metadata?.imageRequestSchemaVersion, "v2");
    assert.equal(buildGenerationConfig(config, node, defaultConfig).imageProviderId, "new");
});

test("layout height follows content wrapping without using scaled screen dimensions and disconnects on unmount", () => {
    const layout = { offsetHeight: 270 };
    const heights: number[] = [];
    let resized = () => {};
    let disconnected = false;
    const source = sourceBehavior(sourceURL, {
        node: { id: "config" },
        layoutRef: { current: layout },
        onLayoutHeightChange: (id: string, height: number) => {
            assert.equal(id, "config");
            heights.push(height);
        },
        ResizeObserver: class {
            constructor(callback: () => void) { resized = callback; }
            observe(target: unknown) { assert.equal(target, layout); }
            disconnect() { disconnected = true; }
        },
    });
    const dispose = source.select((node) => ts.isArrowFunction(node) && ts.isCallExpression(node.parent) && node.parent.expression.getText() === "useLayoutEffect")();
    assert.deepEqual(heights, [274]);
    layout.offsetHeight = 304;
    resized();
    assert.deepEqual(heights, [274, 308]);
    dispose();
    assert.equal(disconnected, true);
});

test("opening input preview registers media targets and closing releases them", () => {
    const targets: unknown[] = [];
    const source = sourceBehavior(sourceURL, {
        previewOpen: true, node: { id: "config" }, previewImageIds: JSON.stringify(["image-a", "image-b"]),
        onPreviewImagesChange: (...args: unknown[]) => targets.push(args),
    });
    const dispose = source.select((node) => ts.isArrowFunction(node) && ts.isCallExpression(node.parent) && node.parent.expression.getText() === "useEffect" && node.getText().includes("JSON.parse(previewImageIds)"))();
    assert.deepEqual(targets, [["config", ["image-a", "image-b"]]]);
    dispose();
    assert.deepEqual(targets[1], ["config", []]);
});
