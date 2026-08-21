import assert from "node:assert/strict";
import test from "node:test";

import { portalStorageScope } from "./portal-storage-scope.ts";

test("uses separate browser storage namespaces for different Portal users", () => {
    assert.equal(portalStorageScope("user-a"), "portal:user-a");
    assert.equal(portalStorageScope("user-b"), "portal:user-b");
    assert.notEqual(portalStorageScope("user-a"), portalStorageScope("user-b"));
});

test("does not assign legacy unscoped data to a Portal user", () => {
    assert.equal(portalStorageScope(""), "portal:guest");
});
