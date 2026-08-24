import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("./app-top-nav.tsx", import.meta.url);
const mobileSourceURL = new URL("./mobile-nav-drawer.tsx", import.meta.url);

test("top navigation returns to the Portal workbench and shows the directory name", async () => {
    const source = await readFile(sourceURL, "utf8");

    assert.match(source, /href="\/"/);
    assert.match(source, />\s*返回工作台\s*</);
    assert.doesNotMatch(source, /appPath\("\/logo\.svg"\)/);
    assert.match(source, /session\.data\?\.user\.displayName/);
});

test("operation records are only exposed through the administrator navigation", async () => {
    const [source, mobileSource] = await Promise.all([readFile(sourceURL, "utf8"), readFile(mobileSourceURL, "utf8")]);

    assert.match(source, /session\.data\?\.isAdmin/);
    assert.match(source, /appPath\("\/admin\/operations"\)/);
    assert.match(mobileSource, /isAdmin/);
    assert.match(mobileSource, /操作记录/);
});
