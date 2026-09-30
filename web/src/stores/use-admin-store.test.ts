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

import { create } from "zustand";
import { ApiRequestError } from "@/services/api/request";
import { sourceModule } from "@/test-utils/source-component";

test("admin access errors distinguish identity, permission and dependency failures", async () => {
    for (const [status, expected] of [[401, "identity"], [403, "forbidden"], [503, "unavailable"]] as const) {
        const module = sourceModule<{ useAdminStore: any }>(new URL("./use-admin-store.ts", import.meta.url), {
            zustand: { create },
            "zustand/middleware": { persist: (initializer: unknown) => initializer },
            "@/services/api/request": { ApiRequestError },
            "@/services/api/admin": { ADMIN_AUTH_TOKEN_KEY: "test", fetchCurrentAdmin: async () => { throw new ApiRequestError("denied", status, 1); } },
        });
        await module.useAdminStore.getState().hydrateAdmin();
        const state = module.useAdminStore.getState();
        assert.equal(state.accessError, expected);
        assert.equal(state.token, "");
        assert.equal(state.user, null);
        assert.equal(state.isReady, true);
    }
});
