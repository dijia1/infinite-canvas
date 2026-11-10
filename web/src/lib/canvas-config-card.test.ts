import assert from "node:assert/strict";
import test from "node:test";

import { getConfigCardView } from "./canvas-config-card";

const defaultCard = { width: 360, height: 274 };

test("the compact layout fits both axes for every node shape", () => {
    for (const card of [defaultCard, { width: 720, height: 274 }, { width: 360, height: 600 }, { width: 220, height: 160 }]) {
        const { designScale } = getConfigCardView(card);
        assert.ok(card.width * designScale >= 216 - 1e-9 && card.height * designScale >= 164 - 1e-9);
    }
});

test("resizing a node scales the compact controls proportionally", () => {
    const original = getConfigCardView(defaultCard).designScale;
    const enlarged = getConfigCardView({ width: defaultCard.width * 2, height: defaultCard.height * 2 }).designScale;
    assert.equal(enlarged, original / 2);
});
