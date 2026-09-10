#!/usr/bin/env python3
"""Summarize raw requests without counting expected business failures as outages."""
import collections
import datetime
import json
import math
import re
from pathlib import Path
import sys


def records(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def percentile(values, fraction):
    if not values:
        return None
    values = sorted(values)
    return values[max(0, math.ceil(len(values) * fraction) - 1)]


def request_summary(rows, seconds):
    latency = [r["ms"] for r in rows]
    return {
        "requests": len(rows), "rps": len(rows) / seconds,
        "successes": sum(not r.get("error") and r["code"] == 0 and 200 <= r["status"] < 300 for r in rows),
        "expected_business": sum(r["expected_business"] for r in rows),
        "unexpected_errors": sum(bool(r.get("error")) for r in rows),
        "http_4xx": sum(400 <= r["status"] < 500 for r in rows),
        "http_5xx": sum(r["status"] >= 500 for r in rows),
        "transport_errors": sum(r["status"] == 0 for r in rows),
        "http_200_body_failures": sum(r["status"] == 200 and r["code"] != 0 for r in rows),
        "statuses": dict(collections.Counter(str(r["status"]) for r in rows)),
        "mean_ms": sum(latency) / len(latency) if latency else None,
        "p50_ms": percentile(latency, .5), "p95_ms": percentile(latency, .95),
        "p99_ms": percentile(latency, .99), "max_ms": max(latency) if latency else None,
        "response_bytes": sum(r["bytes"] for r in rows),
    }


def seconds(value):
    value = re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], value)
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def memory_mib(value):
    number, unit = re.fullmatch(r"([0-9.]+)([A-Za-z]+)", value.strip()).groups()
    return float(number) * {"B": 1 / 1048576, "KiB": 1 / 1024, "MiB": 1, "GiB": 1024,
                           "kB": 1000 / 1048576, "MB": 1000000 / 1048576, "GB": 1000000000 / 1048576}[unit]


def main(root):
    resources = records(root / "resources.ndjson")
    summary = {}
    for users in (10, 30, 50):
        stage_dir = root / str(users)
        if not (stage_dir / "checks.json").exists():
            continue
        stage = json.loads((stage_dir / "stage.json").read_text())
        rows = records(stage_dir / "requests.ndjson")
        metrics = records(stage_dir / "metrics.ndjson")
        steady = [r for r in rows if r["phase"] == "steady" and r["scenario"] not in ("verify", "conflict", "permission")]
        workload = [r for r in rows if r["scenario"] not in ("verify", "conflict", "permission")]
        duration = sum(stage[k] for k in ("ramp_seconds", "hold_seconds", "down_seconds"))
        first, last = metrics[0], metrics[-1]
        elapsed = seconds(last["time"]) - seconds(first["time"])
        cpu = (last["cpu_user_s"] + last["cpu_system_s"] - first["cpu_user_s"] - first["cpu_system_s"]) / elapsed * 100
        pg_calls = last["pg_calls"] - first["pg_calls"]
        query_count = last["query"]["count"] - first["query"]["count"]
        query_time = last["query"]["count"] * last["query"]["mean_ms"] - first["query"]["count"] * first["query"]["mean_ms"]
        samples = [r for r in resources if seconds(first["time"]) <= seconds(r["time"]) <= seconds(last["time"])]
        entry = {"stage": stage, "checks": json.loads((stage_dir / "checks.json").read_text()),
                 "workload_all_phases": request_summary(workload, duration),
                 "steady": request_summary(steady, stage["hold_seconds"]),
                 "api_steady": {api: request_summary([r for r in steady if r["api"] == api], stage["hold_seconds"])
                                for api in sorted({r["api"] for r in steady})},
                 "business_and_conflict": request_summary([r for r in rows if r["scenario"] in ("conflict", "permission")], duration),
                 "scenario_requests": dict(collections.Counter(r["scenario"] for r in workload)),
                 "server": {"samples": len(metrics), "api_cpu_one_core_percent_mean": cpu,
                            "goroutines_start": first["goroutines"], "goroutines_end": last["goroutines"],
                            "goroutines_peak": max(r["goroutines"] for r in metrics),
                            "heap_alloc_start": first["heap_alloc"], "heap_alloc_end": last["heap_alloc"],
                            "heap_alloc_peak": max(r["heap_alloc"] for r in metrics),
                            "heap_inuse_peak": max(r["heap_inuse"] for r in metrics),
                            "go_sys_start": first["go_sys"], "go_sys_end": last["go_sys"],
                            "rss_kib_start": samples[0]["api_rss_kib"] if samples else None,
                            "rss_kib_end": samples[-1]["api_rss_kib"] if samples else None,
                            "rss_kib_peak": max(r["api_rss_kib"] for r in samples) if samples else None,
                            "pg_container_cpu_percent_mean": sum(float(r["postgres_container"]["CPUPerc"].strip("%")) for r in samples) / len(samples) if samples else None,
                            "pg_container_cpu_percent_peak": max(float(r["postgres_container"]["CPUPerc"].strip("%")) for r in samples) if samples else None,
                            "pg_container_memory_mib_peak": max(memory_mib(r["postgres_container"]["MemUsage"].split("/")[0]) for r in samples) if samples else None,
                            "pool_open_peak": max(r["pool"]["OpenConnections"] for r in metrics),
                            "pool_in_use_peak": max(r["pool"]["InUse"] for r in metrics),
                            "pool_wait_count": last["pool"]["WaitCount"] - first["pool"]["WaitCount"],
                            "pool_wait_ms": (last["pool"]["WaitDuration"] - first["pool"]["WaitDuration"]) / 1e6,
                            "pg_active_peak": max(r["pg_active"] for r in metrics),
                            "pg_connections_peak": max(r["pg_connections"] for r in metrics),
                            "pg_lock_waiters_peak": max(r["pg_lock_waiters"] for r in metrics),
                            "pg_blocked_peak": max(r["pg_blocked"] for r in metrics),
                            "pg_query_calls": pg_calls,
                            "pg_exec_mean_ms": (last["pg_exec_ms"] - first["pg_exec_ms"]) / pg_calls if pg_calls else None,
                            "gorm_query_count": query_count, "gorm_query_mean_ms": query_time / query_count if query_count else None,
                            "gorm_over_200ms": last["query"]["slow_over_200ms"] - first["query"]["slow_over_200ms"],
                            "gorm_errors": last["query"]["errors"] - first["query"]["errors"],
                            "fake_submissions": last["fake_submissions"] - first["fake_submissions"],
                            "blocked_http": last["blocked_http"],
                            "runs_end": last["runs"], "attempts_end": last["attempts"],
                            "observer_errors": sorted({r["observer_error"] for r in metrics if r["observer_error"]})}}
        summary[str(users)] = entry
    (root / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    for users, item in summary.items():
        m = item["steady"]
        print(f'{users} users: {m["requests"]} steady requests, {m["rps"]:.2f} RPS, p95={m["p95_ms"]:.2f}ms, '
              f'5xx={m["http_5xx"]}, unexpected={m["unexpected_errors"]}, pool waits={item["server"]["pool_wait_count"]}')


if __name__ == "__main__":
    main(Path(sys.argv[1]))
