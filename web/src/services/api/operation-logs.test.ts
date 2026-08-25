import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("./operation-logs.ts", import.meta.url);

test("operation log API keeps the directory sync POST body empty", async () => {
    const source = await readFile(sourceURL, "utf8");

    assert.match(source, /apiPost<\{ count: number; syncedAt: string \}>\("\/api\/admin\/members\/sync"\)/);
    assert.match(source, /fetchOperationLogs/);
    assert.match(source, /requestSummary\?: string/);
});
