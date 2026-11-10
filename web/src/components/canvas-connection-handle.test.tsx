import assert from "node:assert/strict";
import test from "node:test";
import type { MouseEvent, PointerEvent, ReactElement } from "react";
import type { CanvasConnectionHandle } from "./canvas-node-primitives";
import { canvasThemes } from "@/lib/canvas-theme";
import { sourceModule } from "@/test-utils/source-component";

const { CanvasConnectionHandle: Handle } = sourceModule<{ CanvasConnectionHandle: typeof CanvasConnectionHandle }>(new URL("./canvas-node-primitives.tsx", import.meta.url), {
    "@/lib/canvas-theme": { canvasThemes },
    "@/stores/use-theme-store": { useThemeStore: (read: (state: { theme: string }) => unknown) => read({ theme: "dark" }) },
});

test("canvas mouse handles and workflow pointer handles start connections only for the primary button", () => {
    const calls: string[] = [];
    const root = Handle({ nodeWidth: 340, nodeHeight: 240, side: "right", visible: true,
        onMouseDown: event => calls.push(`mouse:${event.button}`),
        onPointerDown: event => calls.push(`pointer:${event.button}`),
    }) as ReactElement<Record<string, any>>;
    let stopped = false;
    for (const button of [2, 1, 0]) {
        const event = { button, stopPropagation: () => { stopped = true; }, preventDefault: () => { throw Error("context menu must remain available"); } };
        root.props.onMouseDown(event as unknown as MouseEvent<HTMLDivElement>);
        root.props.onPointerDown(event as unknown as PointerEvent<HTMLDivElement>);
    }
    assert.deepEqual(calls, ["mouse:0", "pointer:0"]);
    assert.equal(stopped, false);
    assert.equal(root.props.onContextMenu, undefined);
});

test("hidden handles cannot receive input and keep the existing hover visibility behavior", () => {
    const hidden = Handle({ nodeWidth: 340, nodeHeight: 240, side: "left", visible: false }) as ReactElement<Record<string, any>>;
    const visible = Handle({ nodeWidth: 340, nodeHeight: 240, side: "left", visible: true }) as ReactElement<Record<string, any>>;
    assert.match(hidden.props.className, /pointer-events-none/);
    assert.match(visible.props.className, /pointer-events-auto/);
});
