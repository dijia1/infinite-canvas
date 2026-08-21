import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("admin authentication only uses the Portal session", async () => {
    const [api, store] = await Promise.all([
        readFile(new URL("../services/api/admin.ts", import.meta.url), "utf8"),
        readFile(new URL("./use-admin-store.ts", import.meta.url), "utf8"),
    ]);

    assert.doesNotMatch(api, /\/api\/admin\/login/);
    assert.doesNotMatch(store, /login:\s*async/);
    assert.match(store, /fetchCurrentAdmin\(""\)/);
});
