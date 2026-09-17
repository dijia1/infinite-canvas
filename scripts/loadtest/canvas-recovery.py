#!/usr/bin/env python3
"""30-way Canvas save/replay probes against the runner-owned loopback API."""
import concurrent.futures
import copy
import datetime
import http.client
import json
from pathlib import Path
import statistics
import sys
import threading
import time
import urllib.parse
import uuid

from summarize import percentile

USERS = 30


def main(root):
    manifest = json.loads((root / "manifest.json").read_text())
    target = urllib.parse.urlparse(manifest["url"])
    users = manifest["users"][:USERS]
    if target.scheme != "http" or target.hostname != "127.0.0.1" or not target.port or len(users) != USERS:
        raise ValueError("only the owned loopback test server is allowed")
    if any(not user["uid"].startswith("load-user-") for user in users):
        raise ValueError("refuse non-test accounts")
    output = root / "canvas-recovery"
    output.mkdir()
    lock, local, stop = threading.Lock(), threading.local(), threading.Event()
    observations, samples, failures, connections = [], [], [], []
    active, peak = 0, 0
    phase = "initial"
    started = time.perf_counter()
    log = (output / "requests.ndjson").open("w")

    def connection():
        if not hasattr(local, "connection"):
            local.connection = http.client.HTTPConnection(target.hostname, target.port, timeout=10)
            with lock:
                connections.append(local.connection)
        return local.connection

    def request(user, kind, method, path, body=None, request_id=None, expected=(200,)):
        nonlocal active, peak
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode() if body is not None else None
        headers = {"Content-Type": "application/json", "X-Portal-User-Uid": user["uid"], "X-Portal-Username": user["uid"]}
        if request_id:
            headers.update({"X-Canvas-Request-Id": request_id, "X-Canvas-Tab-Id": "save-stress-" + str(threading.get_ident()), "X-Canvas-Save-Reason": "retry" if "replay" in kind else "autosave"})
        event = {"time": datetime.datetime.now(datetime.timezone.utc).isoformat(), "scenario": phase, "kind": kind,
                 "uid": user["uid"], "request_id": request_id, "request_bytes": len(data or b""), "status": 0, "code": -1}
        with lock:
            active += 1
            peak = max(peak, active)
        begin = time.perf_counter()
        try:
            conn = connection()
            conn.request(method, path, body=data, headers=headers)
            response = conn.getresponse()
            raw = response.read()
            payload = json.loads(raw)
            event.update(status=response.status, code=payload["code"], response_bytes=len(raw))
            if response.status not in expected or ((payload["code"] == 0) != (response.status == 200)):
                raise AssertionError("unexpected HTTP/body status " + str((response.status, payload["code"])))
            return response.status, payload.get("data")
        except Exception as error:
            event["error"] = str(error)
            if hasattr(local, "connection"):
                local.connection.close()
            raise
        finally:
            event["ms"] = (time.perf_counter() - begin) * 1000
            with lock:
                active -= 1
                observations.append(event)
                log.write(json.dumps(event, ensure_ascii=False) + "\n")
                log.flush()

    def snapshot():
        conn = http.client.HTTPConnection(target.hostname, target.port, timeout=5)
        try:
            conn.request("GET", "/__loadtest/metrics")
            response = conn.getresponse()
            assert response.status == 200
            sample = json.loads(response.read())
            sample["scenario"] = phase
            with lock:
                samples.append(sample)
        finally:
            conn.close()

    def monitor():
        while not stop.wait(1):
            try:
                snapshot()
            except Exception as error:
                with lock:
                    failures.append("metrics: " + str(error))

    def wave(pool, action):
        barrier = threading.Barrier(USERS)
        def run(index):
            barrier.wait(timeout=30)
            return action(index)
        return list(pool.map(run, range(USERS)))

    def get(user, canvas_id, kind="verify"):
        return request(user, kind, "GET", "/api/v1/canvas/projects/" + canvas_id)[1]

    def edited(canvas, title, sequence):
        document = copy.deepcopy(canvas["document"])
        document["viewport"]["x"] = sequence
        document["nodes"][0]["position"]["x"] = sequence
        return {"revision": canvas["revision"], "title": title, "document": document}

    def assert_saved(data, canvas_id, body):
        assert data["id"] == canvas_id
        assert data["revision"] == body["revision"] + 1
        assert data["title"] == body["title"]
        assert data["document"] == body["document"], "acknowledgement changed document"

    verified_users = concurrent_replay_rounds = competing_writer_rounds = 0
    final_canvases = []
    snapshot()
    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=USERS) as pool:
            phase = "independent_users"
            canvases = list(pool.map(lambda user: get(user, user["canvasIds"][2], "initial_get"), users))
            initial_revisions = [canvas["revision"] for canvas in canvases]
            # All 30 users write a 250-node document. Discard the first acknowledgement
            # as a client baseline, and only advance after replaying its exact ID/body.
            for round_number in range(20):
                bodies = [edited(canvas, "save-stress-%d-%d" % (i, round_number), round_number + 1) for i, canvas in enumerate(canvases)]
                ids = [str(uuid.uuid4()) for _ in users]
                originals = wave(pool, lambda i: request(users[i], "save", "PUT", "/api/v1/canvas/projects/" + canvases[i]["id"], bodies[i], ids[i])[1])
                replays = wave(pool, lambda i: request(users[i], "replay_after_discarded_ack", "PUT", "/api/v1/canvas/projects/" + canvases[i]["id"], bodies[i], ids[i])[1])
                for i, result in enumerate(replays):
                    assert_saved(result, canvases[i]["id"], bodies[i])
                    assert result == originals[i], "replay did not return the original acknowledgement"
                canvases = replays
            stored = list(pool.map(lambda i: get(users[i], canvases[i]["id"]), range(USERS)))
            for i, result in enumerate(stored):
                assert result == canvases[i], "final database document differs from acknowledged document"
                assert result["revision"] == initial_revisions[i] + 20, "replay advanced revision twice"
            verified_users = USERS
            final_canvases = [{"uid": users[i]["uid"], "id": c["id"], "initial_revision": initial_revisions[i],
                               "final_revision": c["revision"], "node_count": len(c["document"]["nodes"])} for i, c in enumerate(canvases)]
            print("30 independent users: 600 saves + 600 replays; all documents/revisions verified", flush=True)

            # These are 30 sessions of one owner, not cross-user access to a shared Canvas.
            owner, canvas_id = users[0], canvases[0]["id"]
            current = get(owner, canvas_id)
            phase = "same_request_30_sessions"
            for n in range(10):
                body, request_id = edited(current, "concurrent-replay-%d" % n, 1000 + n), str(uuid.uuid4())
                responses = wave(pool, lambda i: request(owner, "concurrent_replay", "PUT", "/api/v1/canvas/projects/" + canvas_id, body, request_id)[1])
                for result in responses:
                    assert_saved(result, canvas_id, body)
                    assert result == responses[0]
                current = get(owner, canvas_id)
                assert current == responses[0], "concurrent copies applied more than once"
                concurrent_replay_rounds += 1
            print("30 simultaneous copies of one request: 10 rounds, no duplicate update", flush=True)

            phase = "different_requests_30_sessions"
            for n in range(10):
                bodies = [edited(current, "contender-%d-round-%d" % (i, n), 2000 + n * USERS + i) for i in range(USERS)]
                ids = [str(uuid.uuid4()) for _ in users]
                responses = wave(pool, lambda i: request(owner, "competing_write", "PUT", "/api/v1/canvas/projects/" + canvas_id, bodies[i], ids[i], (200, 409)))
                winners = [(i, data) for i, (status, data) in enumerate(responses) if status == 200]
                assert len(winners) == 1, "exactly one concurrent writer must win"
                assert sum(status == 409 for status, _ in responses) == USERS - 1
                assert all(data["code"] == "canvas_revision_conflict" for status, data in responses if status == 409)
                winner, acknowledgement = winners[0]
                assert_saved(acknowledgement, canvas_id, bodies[winner])
                current = get(owner, canvas_id)
                assert current == acknowledgement, "stale writer overwrote the winner"
                competing_writer_rounds += 1
            print("30 competing writes: 10 rounds, exactly one winner and 29 conflicts each", flush=True)
    except Exception as error:
        failures.append(type(error).__name__ + ": " + str(error))
    finally:
        stop.set()
        watcher.join(timeout=10)
        snapshot()
        log.close()
        for conn in connections:
            conn.close()
        (output / "metrics.ndjson").write_text("".join(json.dumps(s) + "\n" for s in samples))

    def stats(events):
        durations = [e["ms"] for e in events]
        return {"requests": len(events), "p50_ms": percentile(durations, .5), "p95_ms": percentile(durations, .95),
                "p99_ms": percentile(durations, .99), "max_ms": max(durations, default=0),
                "mean_ms": statistics.mean(durations) if durations else 0,
                "unexpected_errors": sum("error" in e for e in events),
                "http_409": sum(e["status"] == 409 for e in events),
                "http_5xx": sum(e["status"] >= 500 for e in events),
                "transport_errors": sum(e["status"] == 0 for e in events)}
    summary = {"users": USERS, "max_inflight_requests": peak, "duration_seconds": time.perf_counter() - started,
               "verified_users": verified_users, "same_request_rounds": concurrent_replay_rounds,
               "competing_writer_rounds": competing_writer_rounds, "assertion_failures": failures, "all_requests": stats(observations),
               "by_kind": {kind: stats([e for e in observations if e["kind"] == kind]) for kind in sorted({e["kind"] for e in observations})},
               "canvases_before_shared_probes": final_canvases}
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    if failures or summary["all_requests"]["unexpected_errors"]:
        raise SystemExit("Canvas recovery stress test failed: " + str(failures))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
