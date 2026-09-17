import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const entry = new URL("./start-app.mjs", import.meta.url).href;

async function waitForFile(file, child) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        try { return await readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (child.exitCode !== null) throw new Error("supervisor exited before " + file);
        await delay(10);
    }
    throw new Error("timed out waiting for " + file);
}

async function fixture(t, options = {}) {
    const root = await mkdtemp(join(tmpdir(), "canvas-startup-"));
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const apiPort = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    await mkdir(join(root, "web/node_modules/next/dist/bin"), { recursive: true });
    await writeFile(join(root, "server"), `#!${process.execPath}
const fs = require("node:fs"), http = require("node:http");
fs.writeFileSync("api.started", String(process.pid));
process.on("SIGTERM", () => {
    if (fs.existsSync("ignore-term")) return;
    fs.writeFileSync("api.stopped", "stopped"); process.exit(0);
});
http.createServer((req, res) => {
    fs.writeFileSync("api.probed", "probed");
    res.writeHead(fs.existsSync("ready") ? 200 : 503); res.end("health");
}).listen(Number(process.env.PORT), "127.0.0.1");
`, { mode: 0o755 });
    await writeFile(join(root, "web/node_modules/next/dist/bin/next"), `
const fs = require("node:fs");
fs.writeFileSync("../web.started", String(process.pid));
process.on("SIGTERM", () => { fs.writeFileSync("../web.stopped", "stopped"); process.exit(0); });
setInterval(() => {}, 1000);
`);
    if (options.ready) await writeFile(join(root, "ready"), "ready");
    if (options.ignoreTerm) await writeFile(join(root, "ignore-term"), "true");
    if (options.missingAPI) await rm(join(root, "server"));
    const args = { root, apiPort, readinessTimeoutMs: options.timeout ?? 5000, shutdownTimeoutMs: 150 };
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import { startApplication } from ${JSON.stringify(entry)}; process.exitCode = await startApplication(${JSON.stringify(args)});`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    child.stdout.on("data", chunk => { logs += chunk; });
    child.stderr.on("data", chunk => { logs += chunk; });
    const exited = once(child, "exit");
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
        for (const file of ["api.started", "web.started"]) {
            try { process.kill(Number(await readFile(join(root, file), "utf8")), "SIGKILL"); } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
        }
        await rm(root, { recursive: true, force: true });
    });
    const pid = async kind => Number(await waitForFile(join(root, `${kind}.started`), child));
    const assertStopped = async kind => {
        const id = Number(await readFile(join(root, `${kind}.started`), "utf8"));
        assert.throws(() => process.kill(id, 0), { code: "ESRCH" }, kind + " remained alive");
    };
    return { root, child, exited, pid, assertStopped, logs: () => logs };
}

test("frontend waits for backend readiness; backend exit stops frontend and fails container", { timeout: 12000 }, async t => {
    const f = await fixture(t);
    const apiPID = await f.pid("api");
    await waitForFile(join(f.root, "api.probed"), f.child);
    await assert.rejects(access(join(f.root, "web.started")), { code: "ENOENT" });
    await writeFile(join(f.root, "ready"), "ready");
    await f.pid("web");
    process.kill(apiPID, "SIGKILL");
    const [code] = await f.exited;
    assert.equal(code, 1, f.logs());
    await f.assertStopped("web");
});

test("frontend exit stops backend, even when the frontend exits successfully", { timeout: 12000 }, async t => {
    const f = await fixture(t, { ready: true });
    process.kill(await f.pid("web"), "SIGTERM");
    const [code] = await f.exited;
    assert.equal(code, 1, f.logs());
    await f.assertStopped("api");
});

test("shutdown during readiness wait cancels polling without starting frontend", { timeout: 12000 }, async t => {
    const f = await fixture(t);
    await waitForFile(join(f.root, "api.probed"), f.child);
    f.child.kill("SIGTERM");
    const [code] = await f.exited;
    assert.equal(code, 0, f.logs());
    await f.assertStopped("api");
    await assert.rejects(access(join(f.root, "web.started")), { code: "ENOENT" });
});

test("normal container stop terminates both child processes", { timeout: 12000 }, async t => {
    const f = await fixture(t, { ready: true });
    await f.pid("web");
    f.child.kill("SIGTERM");
    const [code] = await f.exited;
    assert.equal(code, 0, f.logs());
    await f.assertStopped("api");
    await f.assertStopped("web");
});

test("readiness timeout fails startup and force-stops an unresponsive backend", { timeout: 12000 }, async t => {
    const f = await fixture(t, { timeout: 250, ignoreTerm: true });
    await f.pid("api");
    const [code] = await f.exited;
    assert.equal(code, 1, f.logs());
    await f.assertStopped("api");
    assert.match(f.logs(), /readiness timed out/);
    await assert.rejects(access(join(f.root, "web.started")), { code: "ENOENT" });
});

test("failure to spawn backend fails container instead of leaving it alive", { timeout: 12000 }, async t => {
    const f = await fixture(t, { missingAPI: true });
    const [code] = await f.exited;
    assert.equal(code, 1, f.logs());
    assert.match(f.logs(), /ENOENT/);
    await assert.rejects(access(join(f.root, "web.started")), { code: "ENOENT" });
});

test("backend failure before readiness never launches frontend", { timeout: 12000 }, async t => {
    const f = await fixture(t);
    const id = await f.pid("api");
    await waitForFile(join(f.root, "api.probed"), f.child);
    process.kill(id, "SIGKILL");
    const [code] = await f.exited;
    assert.equal(code, 1, f.logs());
    await assert.rejects(access(join(f.root, "web.started")), { code: "ENOENT" });
});
