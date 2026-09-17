import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Keep both processes under one container lifecycle. Docker's restart policy
// only runs when PID 1 exits; a surviving frontend must not hide a failed API.
export async function startApplication({ root = process.cwd(), apiPort = 8082, readinessTimeoutMs = 120_000, shutdownTimeoutMs = 8_000 } = {}) {
    const children = new Set();
    const abort = new AbortController();
    let stopping = false;
    let exitCode = 1;
    let killTimer;
    let complete;
    const finished = new Promise(resolve => { complete = resolve; });
    const finishIfStopped = () => {
        if (stopping && children.size === 0) {
            clearTimeout(killTimer);
            complete(exitCode);
        }
    };
    const stop = code => {
        if (stopping) return;
        stopping = true;
        exitCode = code;
        abort.abort();
        for (const child of children) child.kill("SIGTERM");
        if (children.size) {
            killTimer = setTimeout(() => {
                for (const child of children) child.kill("SIGKILL");
            }, shutdownTimeoutMs);
        }
        finishIfStopped();
    };
    const start = (name, command, args, cwd, env) => {
        const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
        children.add(child);
        child.once("error", error => {
            console.error(`[startup] ${name} could not start (${error.code || "spawn error"})`);
            children.delete(child);
            stop(1);
            finishIfStopped();
        });
        child.once("exit", (code, signal) => {
            children.delete(child);
            if (!stopping) {
                console.error(`[startup] ${name} exited (${signal || code}); stopping container`);
                stop(1);
            }
            finishIfStopped();
        });
    };
    const onStop = () => stop(0);
    process.on("SIGTERM", onStop);
    process.on("SIGINT", onStop);

    try {
        start("API", join(root, "server"), [], root, { PORT: String(apiPort) });
        const deadline = Date.now() + readinessTimeoutMs;
        while (!stopping) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error("API readiness timed out");
            let ready = false;
            try {
                const response = await fetch(`http://127.0.0.1:${apiPort}/api/healthz`, {
                    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(Math.min(1000, remaining))]),
                });
                ready = response.ok;
                await response.body?.cancel();
            } catch {
                // A refused connection is expected while the API waits for its database.
            }
            if (ready || stopping) break;
            await delay(250, undefined, { signal: abort.signal });
        }
        if (!stopping) {
            console.log("[startup] API ready; starting frontend");
            start("frontend", process.execPath, ["node_modules/next/dist/bin/next", "start"], join(root, "web"), { HOSTNAME: "0.0.0.0", PORT: "3000" });
        }
    } catch (error) {
        if (!stopping) {
            console.error(`[startup] ${error.message}`);
            stop(1);
        }
    }
    const result = await finished;
    process.off("SIGTERM", onStop);
    process.off("SIGINT", onStop);
    return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await startApplication();
}
