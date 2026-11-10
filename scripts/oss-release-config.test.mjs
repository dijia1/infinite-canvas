import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const compose = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));

test("release pairs the regional endpoint with the new SDK and leaves the old release config intact", async t => {
    const root = await mkdtemp(join(tmpdir(), "canvas-oss-release-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const envFile = join(root, ".env");
    const original = "MEDIA_STORAGE=oss\nOSS_REGION=cn-hongkong\nOSS_BUCKET=fixture-bucket\nOSS_PUBLIC_ENDPOINT=https://legacy.example.invalid\n";
    await writeFile(envFile, original);
    const oldCompose = join(root, "previous.yml");
    await writeFile(oldCompose, "services:\n  app:\n    image: fixture:previous\n    env_file:\n      - ${INFINITE_CANVAS_ENV_FILE}\n");
    const env = { ...process.env, INFINITE_CANVAS_IMAGE: "fixture:regional", INFINITE_CANVAS_ENV_FILE: envFile };
    delete env.OSS_REGION;
    delete env.OSS_PUBLIC_ENDPOINT;
    const render = path => {
        const result = spawnSync("docker", ["compose", "--env-file", envFile, "-f", path, "config", "--format", "json"], { env, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout).services.app.environment;
    };
    const next = render(compose);
    assert.equal(next.OSS_PUBLIC_ENDPOINT, "https://oss-cn-hongkong.aliyuncs.com");
    assert.equal(next.OSS_REGION, "cn-hongkong");
    assert.equal(next.OSS_BUCKET, "fixture-bucket");
    assert.equal(render(oldCompose).OSS_PUBLIC_ENDPOINT, "https://legacy.example.invalid");
    assert.equal(await readFile(envFile, "utf8"), original);
});
