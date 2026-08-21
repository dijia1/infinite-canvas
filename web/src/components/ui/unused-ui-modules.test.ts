import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package manifest omits removed UI dependencies", async () => {
    const manifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };

    for (const dependency of ["motion", "radix-ui", "class-variance-authority", "@codemirror/lang-json", "@uiw/react-codemirror", "dayjs"]) {
        assert.equal(manifest.dependencies[dependency], undefined, `${dependency} should not be direct`);
    }
});
