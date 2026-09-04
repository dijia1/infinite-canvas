import assert from "node:assert/strict";
import test from "node:test";

import { formatCNYAmount, isCNYAmountInput } from "./money.ts";

test("CNY amounts keep decimal strings without Number conversion", () => {
    assert.equal(isCNYAmountInput("0"), true);
    assert.equal(isCNYAmountInput("12.3456"), true);
    assert.equal(isCNYAmountInput("99999999.9999"), true);
    assert.equal(isCNYAmountInput("1.00001"), false);
    assert.equal(isCNYAmountInput("-0.0001"), false);
    assert.equal(isCNYAmountInput("100000000"), false);
    assert.equal(formatCNYAmount("0.1234"), "¥0.1234");
    assert.equal(formatCNYAmount("12"), "¥12.0000");
});
