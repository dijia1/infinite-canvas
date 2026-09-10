#!/usr/bin/env python3
"""Capture expiry writes and database-wide WAL in an owned load-test database."""
import json
from pathlib import Path
import re
import subprocess
import sys


container, output = sys.argv[1:]
if not re.fullmatch(r"infinite-canvas-loadtest-[a-z0-9-]+", container):
    raise SystemExit("refuse non-loadtest container")

query = '''SELECT json_build_object(
 'time', clock_timestamp(),
 'expiry_updates', (
   SELECT json_build_object('calls', coalesce(sum(calls),0), 'rows', coalesce(sum(rows),0),
     'exec_ms', coalesce(sum(total_exec_time),0), 'wal_bytes', coalesce(sum(wal_bytes),0))
   FROM pg_stat_statements
   WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
     AND query LIKE 'UPDATE "media" SET "expires_at"%'
 ),
 'database_wal_position_bytes', pg_wal_lsn_diff(pg_current_wal_insert_lsn(),'0/0'),
 'media_tables', (SELECT json_agg(json_build_object(
   'schema',schemaname, 'updates',n_tup_upd, 'hot_updates',n_tup_hot_upd,
   'dead_tuples_estimate',n_dead_tup, 'autovacuum_count',autovacuum_count,
   'last_autovacuum',last_autovacuum))
   FROM pg_stat_user_tables WHERE schemaname LIKE 'loadtest_%' AND relname='media')
);'''
result = subprocess.check_output([
    "docker", "exec", container, "psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1",
    "-U", "loadtest", "-d", "infinite_canvas_test", "-c", query,
], text=True)
snapshot = json.loads(result)
if len(snapshot["media_tables"] or []) != 1:
    raise SystemExit("expected exactly one owned media table")
Path(output).write_text(json.dumps(snapshot, indent=2) + "\n")
