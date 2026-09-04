import assert from "node:assert/strict";
import test from "node:test";

import { adminNavigationItems } from "./admin-navigation";

test("administrator navigation exposes the same management destinations", () => {
    assert.deepEqual(
        adminNavigationItems.map((item) => item.href),
        ["/admin/members", "/admin/operations", "/admin/statistics", "/admin/settings"],
    );
});
