#!/usr/bin/env python3
"""Read back identity isolation, post-load runtime, and persisted consistency."""
import concurrent.futures
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

root, container = Path(sys.argv[1]), sys.argv[2]
if not container.startswith("infinite-canvas-loadtest-"):
    raise SystemExit("refuse non-loadtest container")
m = json.loads((root / "manifest.json").read_text())
if urllib.parse.urlparse(m["url"]).hostname != "127.0.0.1":
    raise SystemExit("refuse non-local API")


def session(user):
    r = urllib.request.Request(m["url"] + "/api/session", headers={"X-Portal-User-Uid": user["uid"], "X-Portal-Username": user["uid"]})
    with urllib.request.urlopen(r, timeout=10) as response:
        p = json.load(response)
        result = {"uid": user["uid"], "ok": p["code"] == 0 and p["data"]["user"]["uid"] == user["uid"]
                  and not p["data"]["isAdmin"] and response.headers.get("Cache-Control") == "no-store"}
    r = urllib.request.Request(m["url"] + "/api/v1/private-images", headers={"X-Portal-User-Uid": user["uid"]})
    with urllib.request.urlopen(r, timeout=10) as response:
        p = json.load(response)
        result["asset_count"] = p["data"]["total"]
        result["asset_list_ok"] = p["code"] == 0 and p["data"]["total"] >= 200 and len(p["data"]["items"]) == p["data"]["total"]
    return result


with concurrent.futures.ThreadPoolExecutor(max_workers=50) as pool:
    checks = list(pool.map(session, m["users"]))
(root / "session-isolation.json").write_text(json.dumps(checks, indent=2) + "\n")
with (root / "cooldown.ndjson").open("w") as f:
    for i in range(13):
        with urllib.request.urlopen(m["url"] + "/__loadtest/metrics", timeout=10) as response:
            f.write(json.dumps(json.load(response)) + "\n")
            f.flush()
        if i < 12:
            time.sleep(5)


def sql(query):
    return subprocess.check_output(["docker", "exec", container, "psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "loadtest", "-d", "infinite_canvas_test", "-c", query], text=True)


schema = sql("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'loadtest_%'").strip()
if not re.fullmatch(r"loadtest_[a-z0-9_]+", schema):
    raise SystemExit("expected exactly one owned test schema")
query = '''SELECT json_build_object(
 'canvas_revision_mismatches', (SELECT count(*) FROM canvas_projects c WHERE c.revision <> 1+(SELECT count(*) FROM canvas_save_requests r WHERE r.project_id=c.id AND r.user_uid=c.owner_uid)),
 'completed_run_wrong_outputs', (SELECT count(*) FROM workflow_runs r WHERE r.status='completed' AND (SELECT count(*) FROM workflow_output_executions o WHERE o.run_id=r.id AND o.status='succeeded' AND o.media_id<>'')<>7),
 'completed_output_missing_media', (SELECT count(*) FROM workflow_output_executions o LEFT JOIN media m ON m.id=o.media_id WHERE o.status='succeeded' AND m.id IS NULL),
 'output_owner_mismatches', (SELECT count(*) FROM workflow_output_executions o JOIN workflow_runs r ON r.id=o.run_id JOIN media m ON m.id=o.media_id WHERE r.owner_uid<>m.owner_uid),
 'duplicate_attempt_tasks', (SELECT count(*) FROM (SELECT task_id FROM workflow_output_attempts WHERE task_id<>'' GROUP BY task_id HAVING count(*)>1) x),
 'run_statuses', (SELECT json_object_agg(status,n) FROM (SELECT status,count(*) n FROM workflow_runs GROUP BY status) x),
 'attempt_statuses', (SELECT json_object_agg(status,n) FROM (SELECT status,count(*) n FROM workflow_output_attempts GROUP BY status) x),
 'canvas_count', (SELECT count(*) FROM canvas_projects),
 'save_request_count', (SELECT count(*) FROM canvas_save_requests),
 'workflow_count', (SELECT count(*) FROM workflows),
 'media_count', (SELECT count(*) FROM media),
 'media_lifecycle_audit', (SELECT json_object_agg(action,n) FROM (SELECT action,count(*) n FROM operation_logs WHERE target_type='media_lifecycle' GROUP BY action) x),
 'media_expiry_states', (SELECT json_object_agg(state,n) FROM (SELECT CASE WHEN expires_at IS NULL THEN 'retained' ELSE 'expiring' END state,count(*) n FROM media GROUP BY 1) x),
 'pg_settings', (SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN ('server_version','max_connections','shared_buffers','work_mem','effective_cache_size','fsync','synchronous_commit','max_wal_size','track_io_timing','log_min_duration_statement','log_lock_waits','deadlock_timeout'))
);'''
result = sql('SET search_path TO "' + schema + '",public; ' + query).splitlines()[-1]
consistency = json.loads(result)
(root / "consistency.json").write_text(json.dumps(consistency, indent=2) + "\n")
pg = subprocess.check_output(["docker", "exec", container, "psql", "-X", "-U", "loadtest", "-d", "infinite_canvas_test", "--csv", "-c", "SELECT queryid,calls,total_exec_time,mean_exec_time,max_exec_time,rows,shared_blks_hit,shared_blks_read,shared_blk_read_time,shared_blk_write_time,query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 30"], text=True)
(root / "pg-statements.csv").write_text(pg)
failed = [k for k, v in consistency.items() if k in ("canvas_revision_mismatches", "completed_run_wrong_outputs", "completed_output_missing_media", "output_owner_mismatches", "duplicate_attempt_tasks") and v]
if set(consistency["run_statuses"]) != {"completed"}:
    failed.append("runs_not_completed_after_cooldown")
if set(consistency["attempt_statuses"]) != {"succeeded"}:
    failed.append("attempts_not_succeeded_after_cooldown")
if not all(c["ok"] and c["asset_list_ok"] for c in checks) or failed:
    raise SystemExit("post-load consistency checks failed: " + str(failed))
print("50 session identities and persisted consistency checks passed")
