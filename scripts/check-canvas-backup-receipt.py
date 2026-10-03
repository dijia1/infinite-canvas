#!/usr/bin/env python3
"""Read evidence only. Never create a backup, restore data or grant approval."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import stat
import sys

HEALTH_SHA = "af2f6be3d2c6d2f00565a9711b6e2543ea14ec99"
LIFECYCLE_SHA = "66495c5a5dcef0d12ea9b0e96501af9830e2f2c7"
TABLES = {"app_member_roles", "app_rbac_state", "canvas_projects", "canvas_save_requests", "image_generation_task_inputs", "image_generation_tasks", "media", "media_upload_intents", "operation_logs", "portal_members", "private_folders", "public_folders", "public_images", "settings", "video_generation_tasks", "workflow_media_refs", "workflow_output_attempts", "workflow_output_executions", "workflow_runs", "workflow_step_executions", "workflows"}


def private_file(path):
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
        raise ValueError("Private regular evidence file required")


def check(file, state_dir):
    file = Path(file)
    private_file(file)
    if file.stat().st_size > 65536:
        raise ValueError("Receipt too large")
    receipt = json.loads(file.read_text())
    expected = {"version": 1, "application": "infinite-canvas", "database": "internal_tools", "schema": "infinite_canvas", "postgres_major": 16, "baseline_sha": "731a00ad08b90a10403df974d78c433e3e6db887", "health_sha": HEALTH_SHA, "lifecycle_sha": LIFECYCLE_SHA}
    if any(receipt.get(k) != v for k, v in expected.items()):
        raise ValueError("Source/scope evidence differs")
    for field in ("restore_verified", "structure_verified", "migration_verified", "external_access_blocked"):
        if receipt.get(field) is not True:
            raise ValueError("Restore verification incomplete")
    verified = datetime.datetime.fromisoformat(receipt["verified_at"].replace("Z", "+00:00"))
    age = (datetime.datetime.now(datetime.timezone.utc) - verified).total_seconds()
    if age < 0 or age > 86400:
        raise ValueError("Verification must be refreshed within 24 hours")
    snapshot = receipt.get("snapshot_id")
    if not isinstance(snapshot, str) or not snapshot or len(snapshot) > 128:
        raise ValueError("Snapshot evidence missing")
    counts = receipt.get("snapshot_row_counts", {})
    if set(counts) != TABLES or any(type(v) is not int or v < 0 for v in counts.values()):
        raise ValueError("All 21 snapshot counts required")
    artifact = Path(receipt["backup_path"])
    state_root = Path(state_dir).resolve(strict=True)
    scope = (state_root / "backups").resolve(strict=True)
    scope.relative_to(state_root)
    artifact.resolve(strict=True).relative_to(scope)
    private_file(artifact)
    expected_hash = receipt.get("backup_sha256", "")
    if re.fullmatch("[a-f0-9]{64}", expected_hash) is None:
        raise ValueError("Backup checksum missing")
    digest = hashlib.sha256()
    with artifact.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected_hash:
        raise ValueError("Backup checksum differs")


if __name__ == "__main__":
    try:
        check(sys.argv[1], sys.argv[2])
    except Exception:
        print("Canvas backup/restore evidence is missing, stale or inconsistent.", file=sys.stderr)
        sys.exit(1)
