import assert from "node:assert/strict";
import test from "node:test";

import { navigationTools } from "./navigation-tools.ts";

test("does not expose the removed prompt library in primary navigation", () => {
    assert.equal(navigationTools.some((tool) => String(tool.slug) === "prompts"), false);
});

test("does not expose my assets as a route because it opens in a drawer", () => {
    assert.equal(navigationTools.some((tool) => String(tool.slug) === "assets"), false);
});
