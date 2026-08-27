import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("./canvas-config-node-panel.tsx", import.meta.url);

test("config-node model menus isolate pointer events from the canvas and their portal", async () => {
	const source = await readFile(sourceURL, "utf8");

	assert.match(source, /function CanvasConfigModelSelect/);
	assert.match(source, /data-canvas-no-zoom/);
	assert.match(source, /popupRender/);
	assert.match(source, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
});
