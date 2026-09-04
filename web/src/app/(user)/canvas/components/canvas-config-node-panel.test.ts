import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("./canvas-config-node-panel.tsx", import.meta.url);
const promptPanelSourceURL = new URL("./canvas-node-prompt-panel.tsx", import.meta.url);

test("config-node model menus isolate pointer events from the canvas and their portal", async () => {
	const source = await readFile(sourceURL, "utf8");

	assert.match(source, /function CanvasConfigModelSelect/);
	assert.match(source, /data-canvas-no-zoom/);
	assert.match(source, /popupRender/);
	assert.match(source, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
});

test("config-node model selector fills the generation action width", async () => {
	const source = await readFile(sourceURL, "utf8");

	assert.match(source, /<div className="w-full" data-canvas-no-zoom/);
	assert.match(source, /className="!w-full"/);
	assert.match(source, /popupMatchSelectWidth/);
});

test("generation panels share the canvas generation config resolver", async () => {
    const [configPanelSource, promptPanelSource] = await Promise.all([readFile(sourceURL, "utf8"), readFile(promptPanelSourceURL, "utf8")]);

    for (const source of [configPanelSource, promptPanelSource]) {
        assert.match(source, /import \{ buildGenerationConfig \} from "\.\.\/utils\/canvas-generation-utils"/);
        assert.doesNotMatch(source, /function buildNodeConfig/);
        assert.match(source, /buildGenerationConfig\(globalConfig, node, defaultConfig\)/);
    }
});
