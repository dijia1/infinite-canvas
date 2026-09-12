import assert from "node:assert/strict";
import test from "node:test";
import { hitTestCanvasFrames, canvasFrameScreenMetrics } from "./canvas-frame-interaction";
const frame = (id = "a", x = 0) => ({id, name:id, position:{x,y:0}, width:1000, height:600, nodeIds:[]});
const view = (k=1) => ({x:100,y:100,k});

test("zoomed-out Frame can be resized 20 screen pixels outside each side without selection", () => {
    for (const [point,direction] of [[{x:80,y:142},"left"],[{x:260,y:142},"right"],[{x:170,y:80},"top"],[{x:170,y:204},"bottom"]] as const) {
        assert.equal(hitTestCanvasFrames([frame()], point, view(.14))?.direction,direction);
    }
    assert.equal(hitTestCanvasFrames([frame()],{x:78,y:142},view(.14)),null);
    assert.equal(hitTestCanvasFrames([frame()],{x:80,y:400},view()),null);
});
test("corners win within a Frame; adjacent borders select the nearest rather than DOM order", () => {
    assert.equal(hitTestCanvasFrames([frame()],{x:106,y:106},view(.14))?.direction,"top-left");
    const a=frame("a"),b=frame("b",1020);
    assert.equal(hitTestCanvasFrames([b,a],{x:1108,y:400},view(),"b")?.frameId,"a");
    assert.equal(hitTestCanvasFrames([a,b],{x:1110,y:400},view(),"b")?.frameId,"b");
});
test("tiny Frames retain a centre free of resize hit targets", () => {
    const small={...frame(),width:240,height:160};
    assert.equal(hitTestCanvasFrames([small],{x:106,y:104},view(.05)),null);
    assert.equal(hitTestCanvasFrames([small],{x:80,y:104},view(.05))?.direction,"left");
});
test("metrics interpolate and clamp in screen space", () => {
    assert.deepEqual(canvasFrameScreenMetrics(.14),{border:3,edge:28,corner:36});
    assert.deepEqual(canvasFrameScreenMetrics(.65),{border:2.5,edge:22,corner:30});
    assert.deepEqual(canvasFrameScreenMetrics(5),{border:2,edge:16,corner:24});
});
