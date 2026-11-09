"""Verify idempotency by replaying a saved USGS response twice.

Run refresh.py first. This deliberately replays exactly the same input twice.
"""

from contextlib import closing
import json
from pathlib import Path
import sqlite3

from ingest import PROJECT_ROOT, ingest


def counts(database):
    with closing(sqlite3.connect(database)) as connection:
        return {
            "current_observations": connection.execute("SELECT COUNT(*) FROM observations WHERE source='usgs'").fetchone()[0],
            "revisions": connection.execute("SELECT COUNT(*) FROM observation_revisions WHERE source='usgs'").fetchone()[0],
            "runs": connection.execute("SELECT COUNT(*) FROM ingestion_runs WHERE source='usgs'").fetchone()[0],
        }


def main():
    data_directory = PROJECT_ROOT / "data"
    database = data_directory / "earthwatch.sqlite"
    if not database.exists():
        raise SystemExit("Run python pipeline/refresh.py first.")
    with closing(sqlite3.connect(database)) as connection:
        row = connection.execute("SELECT raw_path FROM ingestion_runs WHERE source='usgs' AND status='succeeded' ORDER BY finished_at DESC LIMIT 1").fetchone()
    if not row or not Path(row[0]).exists():
        raise SystemExit("No saved USGS response is available. Run refresh.py first.")
    raw_file = Path(row[0])
    payload = json.loads(raw_file.read_bytes())
    example = next(iter(payload["features"]), None)
    print("Source record")
    print(json.dumps(example, indent=2, ensure_ascii=False))
    print("\nBEFORE", counts(database))
    first = ingest("usgs", data_directory, raw_file)
    after_first = counts(database)
    second = ingest("usgs", data_directory, raw_file)
    after_second = counts(database)
    print("FIRST REPLAY", first)
    print("AFTER FIRST", after_first)
    print("SECOND REPLAY", second)
    print("AFTER SECOND", after_second)
    assert after_second["current_observations"] == after_first["current_observations"]
    assert after_second["revisions"] == after_first["revisions"]
    assert after_second["runs"] == after_first["runs"] + 1
    print("\nPASS: another run was logged, but no duplicate observations or revisions were added.")


if __name__ == "__main__":
    main()
