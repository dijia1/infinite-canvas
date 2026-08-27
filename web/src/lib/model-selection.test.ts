import assert from "node:assert/strict";
import test from "node:test";

import { resolveSelectedModel } from "./model-selection";

const imageModels = [
    { id: "maizi", name: "MaiziAI", type: "maizi-image" },
    { id: "seedream", name: "Seedream 5.0 Pro", type: "doubao-seedream-5-pro" },
];

test("uses a persisted enabled model and falls back to the administrator default", () => {
    assert.equal(resolveSelectedModel(imageModels, "seedream", "maizi")?.id, "seedream");
    assert.equal(resolveSelectedModel(imageModels, "removed", "maizi")?.id, "maizi");
    assert.equal(resolveSelectedModel(imageModels, "", "missing")?.id, "maizi");
});
