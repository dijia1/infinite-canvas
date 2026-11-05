import assert from "node:assert/strict";
import test from "node:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { canvasThemes } from "@/lib/canvas-theme";
import { CanvasConnectionCreateMenuContent as CanvasConnectionCreateMenu, connectionMenuPosition } from "./canvas-connection-create-menu";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    return Children.toArray(node).flatMap((child) => {
        if (!isValidElement<Record<string, unknown>>(child)) return [];
        return [child, ...elements(child.props.children as ReactNode)];
    });
}

test("menu only invokes the selected caller action; closing does not create a node", () => {
    const calls: string[] = [];
    const menu = CanvasConnectionCreateMenu({
        title: "连接并创建", theme: canvasThemes.dark,
        options: [
            { id: "image_generation", title: "生图配置", icon: <span />, onClick: () => calls.push("image_generation") },
            { id: "video_generation", title: "视频配置", icon: <span />, onClick: () => calls.push("video_generation") },
        ],
        onClose: () => calls.push("close"),
    });
    const buttons = elements(menu).filter((element) => element.type === "button");
    assert.equal(buttons.length, 3);
    (buttons[2]!.props.onClick as () => void)();
    (buttons[0]!.props.onClick as () => void)();
    assert.deepEqual(calls, ["video_generation", "close"]);
    let stopped = 0;
    menu.props.onMouseDown({ stopPropagation: () => stopped++ });
    menu.props.onPointerDown({ stopPropagation: () => stopped++ });
    assert.equal(stopped, 2);
});

test("menu preserves caller labels and optional descriptions in both themes", () => {
    for (const theme of Object.values(canvasThemes)) {
        const markup = renderToStaticMarkup(<CanvasConnectionCreateMenu title="引用该节点生成" theme={theme} onClose={() => {}} options={[
            { id: "text", title: "文本节点", description: "脚本、广告词、品牌文案", icon: <span />, onClick: () => {} },
            { id: "config", title: "配置节点", icon: <span />, onClick: () => {} },
        ]} />);
        assert.match(markup, /引用该节点生成/);
        assert.match(markup, /脚本、广告词、品牌文案/);
        assert.match(markup, /配置节点/);
        assert.ok(markup.includes(`color:${theme.node.text}`));
        assert.doesNotMatch(markup, /图片生成|视频生成/);
    }
});

test("menu follows a world drop point while keeping screen-space dimensions", () => {
    const position = { x: -100, y: 120 };
    for (const k of [0.05, 0.14, 0.42, 1, 1.52, 5]) {
        const viewport = { x: 400 + 100 * k, y: 200 - 120 * k, k };
        assert.deepEqual(connectionMenuPosition(position, viewport, { width: 1000, height: 700 }, { width: 300, height: 340 }), { left: 400, top: 200 });
    }
    assert.deepEqual(position, { x: -100, y: 120 });
});

test("menu flips above the drop point and stays within the viewport edges", () => {
    const position = { x: 985, y: 680 };
    const viewport = { x: 0, y: 0, k: 1 };
    const size = { width: 1000, height: 700 };
    const menu = { width: 300, height: 340 };
    assert.deepEqual(connectionMenuPosition(position, viewport, size, menu), { left: 688, top: 340 });
    assert.deepEqual(connectionMenuPosition({ x: -20, y: -30 }, viewport, size, menu), { left: 12, top: 12 });
    assert.deepEqual(position, { x: 985, y: 680 });
});

test("menu fits a narrow viewport after its scrollable size has been constrained", () => {
    assert.deepEqual(connectionMenuPosition({ x: 290, y: 180 }, { x: 0, y: 0, k: 1 }, { width: 320, height: 240 }, { width: 296, height: 216 }), { left: 12, top: 12 });
});
