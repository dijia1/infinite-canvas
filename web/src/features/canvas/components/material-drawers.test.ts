import assert from "node:assert/strict";
import test from "node:test";

import { materialThumbnailGridClass } from "./material-folder-ui.tsx";

test("maps every thumbnail stage to the supported grid class", () => {
    assert.deepEqual([0, 1, 2, 3].map(materialThumbnailGridClass), ["grid-cols-6", "grid-cols-4", "grid-cols-3", "grid-cols-2"]);
});
