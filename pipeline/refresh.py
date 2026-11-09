"""Run the small batch pipeline and atomically export the app's JSON snapshot.

This script runs once and exits. GitHub Actions provides the hourly schedule.
No web server, background loop, API key or non-standard Python package is needed.
"""

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import sys

from ingest import SOURCES, SOURCE_NAMES, PROJECT_ROOT, ingest, initialize_database, utc_now


def export_snapshot(data_directory, destination):
    connection = sqlite3.connect(data_directory / "earthwatch.sqlite")
    initialize_database(connection)
    observations = []
    statuses = []
    try:
        for source, name in SOURCE_NAMES.items():
            latest = connection.execute(
                "SELECT status, started_at, error FROM ingestion_runs WHERE source=? ORDER BY started_at DESC LIMIT 1", (source,)
            ).fetchone()
            success = connection.execute(
                "SELECT finished_at, accepted_count, rejected_count FROM ingestion_runs WHERE source=? AND status='succeeded' ORDER BY finished_at DESC LIMIT 1", (source,)
            ).fetchone()
            statuses.append({
                "name": name, "ok": bool(latest and latest[0] == "succeeded"),
                "receivedAt": int(datetime.fromisoformat(success[0]).timestamp() * 1000) if success else None,
                "count": success[1] if success else 0, "rejected": success[2] if success else 0,
                "message": latest[2] if latest else "Source has not run yet.",
            })
        for (display_json,) in connection.execute("SELECT display_json FROM observations WHERE display_json IS NOT NULL"):
            observations.append(json.loads(display_json))
    finally:
        connection.close()
    payload = {
        "schemaVersion": 1, "generatedAt": int(datetime.now(timezone.utc).timestamp() * 1000),
        "sources": statuses,
        "observations": sorted(observations, key=lambda item: item["observedAt"], reverse=True),
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    temporary.replace(destination)
    return payload


def prune_old_raw(data_directory):
    """Keep a week of original responses. SQLite keeps the revision history."""
    # Retention: 7 days of revisions and 14 days of run logs.
    # Existing raw files are immutable until their documented retention expires.
    connection = sqlite3.connect(data_directory / "earthwatch.sqlite")
    try:
        revision_cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        # Artifact extraction can reset filesystem modification times. Use the
        # recorded run time instead, so old raw files really do expire in cloud runs.
        expired_ids = {row[0] for row in connection.execute(
            "SELECT run_id FROM ingestion_runs WHERE started_at < ?", (revision_cutoff,)
        )}
        for source in SOURCES:
            for path in (data_directory / "raw" / source).glob("*"):
                if path.is_file() and path.stem in expired_ids:
                    path.unlink()
        with connection:
            run_cutoff = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
            connection.execute("DELETE FROM observation_revisions WHERE received_at < ?", (revision_cutoff,))
            connection.execute("DELETE FROM ingestion_runs WHERE started_at < ? AND run_id NOT IN (SELECT run_id FROM observation_revisions)", (run_cutoff,))
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=PROJECT_ROOT / "data")
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "dist" / "data" / "observations.json")
    parser.add_argument("--export-only", action="store_true", help="Export the current database without fetching sources")
    arguments = parser.parse_args()
    arguments.data_dir.mkdir(parents=True, exist_ok=True)
    failures = 0
    if not arguments.export_only:
        for source in SOURCES:
            try:
                print(json.dumps(ingest(source, arguments.data_dir)))
            except Exception as error:
                failures += 1
                print(f"{source}: {error}", file=sys.stderr)
    payload = export_snapshot(arguments.data_dir, arguments.output)
    prune_old_raw(arguments.data_dir)
    print(f"Exported {len(payload['observations'])} observations to {arguments.output}")
    # Export partial results but mark the job failed so a broken source is visible.
    # The workflow still preserves state and publishes explicit failed-source status.
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
