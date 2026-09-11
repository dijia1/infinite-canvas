import assert from "node:assert/strict";
import test from "node:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { canvasThemes } from "@/lib/canvas-theme";
import { CanvasConnectionCreateMenu } from "./canvas-connection-create-menu";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    return Children.toArray(node).flatMap((child) => {
        if (!isValidElement<Record<string, unknown>>(child)) return [];
        return [child, ...elements(child.props.children as ReactNode)];
    });
}

test("menu only invokes the selected caller action; closing does not create a node", () => {
    const calls: string[] = [];
    const menu = CanvasConnectionCreateMenu({
        title: "连接并创建", position: { x: -40, y: 80 }, theme: canvasThemes.dark,
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
    assert.deepEqual([menu.props.style.left, menu.props.style.top], [-40, 80]);
    let stopped = 0;
    menu.props.onMouseDown({ stopPropagation: () => stopped++ });
    menu.props.onPointerDown({ stopPropagation: () => stopped++ });
    assert.equal(stopped, 2);
});

test("menu preserves caller labels and optional descriptions in both themes", () => {
    for (const theme of Object.values(canvasThemes)) {
        const markup = renderToStaticMarkup(<CanvasConnectionCreateMenu title="引用该节点生成" position={{ x: 10, y: 20 }} theme={theme} onClose={() => {}} options={[
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
