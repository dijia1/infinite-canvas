import assert from "node:assert/strict";
import test from "node:test";

import { applyCanvasSceneViewport, finishCanvasPan, type CanvasPanState } from "./infinite-canvas.tsx";

test("finishing a middle-button pan always clears the dragging state", () => {
    const state: CanvasPanState = { isPanning: true, startX: 10, startY: 20, initialX: 0, initialY: 0, hasMoved: true };
    let deselects = 0;

    assert.equal(finishCanvasPan(state, () => deselects++), true);
    assert.equal(state.isPanning, false);
    assert.equal(deselects, 0);
});

test("finishing an unmoved pan deselects once and remains idempotent", () => {
    const state: CanvasPanState = { isPanning: true, startX: 10, startY: 20, initialX: 0, initialY: 0, hasMoved: false };
    let deselects = 0;

    assert.equal(finishCanvasPan(state, () => deselects++), true);
    assert.equal(finishCanvasPan(state, () => deselects++), false);
    assert.equal(deselects, 1);
});

test("the same viewport apply publishes Frame scale before React commits", () => {
    const properties = new Map<string,string>();
    const scene = {style:{transform:"",setProperty:(key:string,value:string)=>properties.set(key,value),getPropertyValue:(key:string)=>properties.get(key)||""}};
    applyCanvasSceneViewport(scene, {x:40,y:60,k:.14});
    assert.equal(scene.style.transform,"translate3d(40px, 60px, 0) scale(0.14)");
    assert.equal(Number(properties.get("--canvas-scale")),.14);
    assert.ok(Math.abs(Number(properties.get("--canvas-inverse-scale")) * .14 - 1)<1e-10);
    assert.equal(properties.get("--canvas-frame-border-screen-width"),"3px");
    applyCanvasSceneViewport(scene, {x:40,y:60,k:5});
    assert.equal(Number(properties.get("--canvas-inverse-scale")),.2);
    assert.equal(properties.get("--canvas-frame-border-screen-width"),"2px");
});

test("scene viewport application skips an already applied viewport", () => {
    const properties = new Map<string, string>();
    let transform = "";
    let transformWrites = 0;
    let propertyWrites = 0;
    const scene = {
        style: {
            get transform() {
                return transform;
            },
            set transform(value: string) {
                transform = value;
                transformWrites++;
            },
            setProperty(key: string, value: string) {
                properties.set(key, value);
                propertyWrites++;
            },
            getPropertyValue(key: string) {
                return properties.get(key) || "";
            },
        },
    };
    const initial = { x: 40, y: 60, k: 0.14 };

    assert.equal(applyCanvasSceneViewport(scene, initial, null), true);
    assert.equal(transformWrites, 1);
    assert.equal(propertyWrites, 3);

    assert.equal(applyCanvasSceneViewport(scene, initial, initial), false);
    assert.equal(transformWrites, 1);
    assert.equal(propertyWrites, 3);

    const moved = { ...initial, x: 52 };
    assert.equal(applyCanvasSceneViewport(scene, moved, initial), true);
    assert.equal(transform, "translate3d(52px, 60px, 0) scale(0.14)");
    assert.equal(transformWrites, 2);
    assert.equal(propertyWrites, 3);

    const scaled = { ...moved, k: 0.2 };
    assert.equal(applyCanvasSceneViewport(scene, scaled, moved), true);
    assert.equal(transform, "translate3d(52px, 60px, 0) scale(0.2)");
    assert.equal(transformWrites, 3);
    assert.equal(propertyWrites, 6);
    assert.equal(properties.get("--canvas-scale"), "0.2");
});
