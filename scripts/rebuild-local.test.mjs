import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = join(dirname(fileURLToPath(import.meta.url)), 'rebuild-local.sh');
function run(t, failStep = '') {
    const root = mkdtempSync(join(tmpdir(), 'canvas-local-rebuild-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'bin'));
    copyFileSync(source, join(root, 'scripts/rebuild-local.sh'));
    const log = join(root, 'calls.jsonl');
    writeFileSync(join(root, 'bin/docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.REBUILD_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[3] === process.env.REBUILD_TEST_FAIL) process.exit(17);
`, { mode: 0o755 });
    const result = spawnSync('bash', [join(root, 'scripts/rebuild-local.sh')], {
        cwd: tmpdir(), encoding: 'utf8',
        env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, REBUILD_TEST_LOG: log, REBUILD_TEST_FAIL: failStep },
    });
    return { result, calls: readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('local rebuild migrates the new image before replacing only app', (t) => {
    const { result, calls } = run(t);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, [
        ['compose', '-f', 'docker-compose.local.yml', 'build', 'app'],
        ['compose', '-f', 'docker-compose.local.yml', 'run', '--rm', '--no-deps', 'app', '/app/migrate'],
        ['compose', '-f', 'docker-compose.local.yml', 'up', '-d', '--no-deps', 'app'],
    ]);
});
for (const step of ['build', 'run']) test(`local rebuild stops before app replacement when ${step} fails`, (t) => {
    const { result, calls } = run(t, step);
    assert.equal(result.status, 17);
    assert.ok(calls.every((args) => args[3] !== 'up'));
});
