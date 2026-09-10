#!/usr/bin/env python3
"""Observe only the owned load-test PostgreSQL container and native API PID."""
import argparse
import datetime
import json
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument("--manifest", required=True)
p.add_argument("--container", required=True)
p.add_argument("--out", required=True)
args = p.parse_args()
if not args.container.startswith("infinite-canvas-loadtest-"):
    raise SystemExit("Refuse non-loadtest container")
with open(args.manifest) as f:
    pid = int(json.load(f)["pid"])
with open(args.out, "w") as f:
    while True:
        try:
            rss = subprocess.check_output(["ps", "-o", "rss=", "-p", str(pid)], text=True).strip()
            stats = subprocess.check_output(
                ["docker", "stats", "--no-stream", "--format", "{{json .}}", args.container],
                text=True, timeout=10,
            ).strip()
            f.write(json.dumps({"time": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                "api_rss_kib": int(rss), "postgres_container": json.loads(stats)}) + "\n")
            f.flush()
        except subprocess.CalledProcessError:
            break
        time.sleep(5)
