import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG_ICONS_MAX_SCALE, getConfigCardView } from "./canvas-config-card";

const defaultCard = { width: 360, height: 274 };

test("the form depends only on zoom, with icons below the threshold", () => {
    assert.equal(getConfigCardView(defaultCard, 0.79).form, "controls");
    assert.equal(getConfigCardView(defaultCard, CONFIG_ICONS_MAX_SCALE).form, "controls");
    assert.equal(getConfigCardView(defaultCard, CONFIG_ICONS_MAX_SCALE - 0.001).form, "icons");
    assert.equal(getConfigCardView(defaultCard, 0.05).form, "icons");
});

test("a form's design scale does not change with zoom, so its layout never reflows", () => {
    const controls = [0.79, 0.6, 0.3, 0.19].map((zoom) => getConfigCardView(defaultCard, zoom).designScale);
    const icons = [0.18, 0.1, 0.05].map((zoom) => getConfigCardView(defaultCard, zoom).designScale);
    assert.equal(new Set(controls).size, 1);
    assert.equal(new Set(icons).size, 1);
});

test("the design scale gives each form enough room on both axes, whatever the card's shape", () => {
    for (const card of [defaultCard, { width: 720, height: 274 }, { width: 360, height: 600 }, { width: 220, height: 160 }]) {
        const controls = getConfigCardView(card, 0.5).designScale;
        assert.ok(card.width * controls >= 176 - 1e-9 && card.height * controls >= 134 - 1e-9);
        const icons = getConfigCardView(card, 0.1).designScale;
        assert.ok(card.width * icons >= 68 - 1e-9 && card.height * icons >= 40 - 1e-9);
    }
});
