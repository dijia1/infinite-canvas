import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Frontend requests can still call the API while Next drains. Stop the API only
// after Next's native server.close completes. One deadline covers both children.
export async function startApplication({ root = process.cwd(), apiPort = 8082, readinessTimeoutMs = 120_000, shutdownTimeoutMs = 25_000 } = {}) {
    const children = new Map();
    const abort = new AbortController();
    let stopping = false;
    let exitCode = 1;
    let killTimer;
    let complete;
    const finished = new Promise(resolve => { complete = resolve; });
    const stopChild = async name => {
        const record = children.get(name);
        if (!record) return;
        record.expectedStop = true;
        record.child.kill("SIGTERM");
        const { code, signal } = await record.done;
        // Next 16 exits 143 after its native SIGTERM cleanup. A killed or failed
        // backend, or any other frontend exit, must never report a clean stop.
        if (signal || (code !== 0 && !(name === "frontend" && code === 143))) exitCode = 1;
    };
    const stop = code => {
        if (stopping) return;
        stopping = true;
        exitCode = code;
        abort.abort();
        // Quiesce background admission while keeping HTTP available to the draining
        // frontend. The native Go process reserves SIGUSR1 for this first phase.
        children.get("API")?.child.kill("SIGUSR1");
        console.log("[shutdown] stopping frontend before API");
        killTimer = setTimeout(() => {
            exitCode = 1;
            console.error("[shutdown] deadline exceeded; force-stopping children");
            for (const { child } of children.values()) child.kill("SIGKILL");
        }, shutdownTimeoutMs);
        void (async () => {
            await stopChild("frontend");
            await stopChild("API");
            clearTimeout(killTimer);
            console.log(`[shutdown] complete (${exitCode})`);
            complete(exitCode);
        })();
    };
    const start = (name, command, args, cwd, env) => {
        const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
        let resolveDone;
        const record = { child, expectedStop: false, done: new Promise(resolve => { resolveDone = resolve; }) };
        children.set(name, record);
        const onExit = (code, signal) => {
            children.delete(name);
            resolveDone({ code, signal });
            if (!record.expectedStop) {
                exitCode = 1;
                console.error(`[startup] ${name} exited (${signal || code}); stopping container`);
                stop(1);
            }
        };
        child.once("error", error => {
            console.error(`[startup] ${name} could not start (${error.code || "spawn error"})`);
            onExit(1, null);
        });
        child.once("exit", onExit);
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
