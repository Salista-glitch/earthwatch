"""EarthWatch source ingestion. Python standard library only.

Data flow: fetch -> preserve raw response -> normalize -> store observations.
refresh.py runs the sources and exports a small public snapshot for the browser.
"""

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import math
from pathlib import Path
import sqlite3
from urllib.request import Request, urlopen
import uuid


SOURCES = {
    "usgs": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson",
    "eonet": "https://eonet.gsfc.nasa.gov/api/v3/events?status=all&days=30",
    # Public download, discovered via NASA's official active_fire file index.
    # Scope: NOAA-20 VIIRS observations for southern Africa.
    "firms": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Southern_Africa_24h.csv",
}
SOURCE_NAMES = {"usgs": "USGS", "eonet": "NASA EONET", "firms": "NASA FIRMS"}
PROJECT_ROOT = Path(__file__).resolve().parents[1]


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def canonical_json(value):
    """Stable key order makes hashes independent of JSON property ordering."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def valid_point(coordinates):
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        return False
    longitude, latitude = coordinates[:2]
    return (
        type(longitude) in (int, float)
        and type(latitude) in (int, float)
        and -180 <= longitude <= 180
        and -90 <= latitude <= 90
    )


def normalize(source, payload):
    """Return accepted records and a rejection count; never invent coordinates."""
    records = []
    rejected = 0
    if source == "firms":
        return normalize_fires(payload)
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object")
    if source == "usgs":
        if not isinstance(payload.get("features"), list):
            raise ValueError("USGS payload must contain a features list")
        for feature in payload["features"]:
            coordinates = (feature.get("geometry") or {}).get("coordinates", [])
            properties = feature.get("properties") or {}
            timestamp = properties.get("time")
            if not feature.get("id") or not valid_point(coordinates) or type(timestamp) not in (int, float):
                rejected += 1
                continue
            try:
                observed_at = datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat()
            except (ValueError, OverflowError, OSError):
                rejected += 1
                continue
            records.append({
                "observation_id": str(feature["id"]),
                "event_id": str(feature["id"]),
                "title": properties.get("place") or "Location not supplied",
                "kind": "Earthquake",
                "longitude": coordinates[0], "latitude": coordinates[1],
                "observed_at": observed_at,
                "source_record": feature,
            })
    elif source == "eonet":
        if not isinstance(payload.get("events"), list):
            raise ValueError("EONET payload must contain an events list")
        for event in payload["events"]:
            if not event.get("id"):
                rejected += 1
                continue
            for index, geometry in enumerate(event.get("geometry") or []):
                coordinates = geometry.get("coordinates", [])
                # Polygon support is a separate milestone, not an invented centroid.
                if geometry.get("type") != "Point" or not valid_point(coordinates):
                    rejected += 1
                    continue
                try:
                    observed_at = datetime.fromisoformat(geometry["date"].replace("Z", "+00:00"))
                    if observed_at.tzinfo is None:
                        raise ValueError("Timestamp has no timezone")
                except (KeyError, TypeError, ValueError):
                    rejected += 1
                    continue
                records.append({
                    "observation_id": str(event["id"]) + ":" + geometry["date"] + ":" + str(index),
                    "event_id": str(event["id"]), "title": event.get("title") or "Untitled event",
                    "kind": ", ".join(category["title"] for category in event.get("categories", []) if "title" in category),
                    "longitude": coordinates[0], "latitude": coordinates[1],
                    "observed_at": observed_at.astimezone(timezone.utc).isoformat(),
                    "source_record": {"event": event, "geometry": geometry},
                })
    else:
        raise ValueError("Unknown source")
    return records, rejected


def normalize_fires(csv_text):
    """One VIIRS pixel detection is one observation, not a whole fire incident."""
    reader = csv.DictReader(io.StringIO(csv_text.lstrip("\ufeff")))
    required = {"latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence"}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("FIRMS response is missing required CSV columns")
    records = []
    rejected = 0
    for row in reader:
        try:
            latitude = float(row["latitude"])
            longitude = float(row["longitude"])
            if not valid_point([longitude, latitude]):
                raise ValueError("Invalid coordinates")
            # Leading zeros matter: 0030 means 00:30 UTC, not 30 o'clock.
            time = row["acq_time"].strip().zfill(4)
            if len(time) != 4 or not time.isdigit():
                raise ValueError("Invalid acquisition time")
            observed_at = datetime.strptime(row["acq_date"] + time, "%Y-%m-%d%H%M").replace(tzinfo=timezone.utc)
            if not row["satellite"]:
                raise ValueError("Missing satellite")
        except (KeyError, TypeError, ValueError):
            rejected += 1
            continue
        identity = "|".join([row["satellite"], "VIIRS", observed_at.isoformat(), f"{latitude:.6f}", f"{longitude:.6f}"])
        detection_id = hashlib.sha256(identity.encode()).hexdigest()[:24]
        records.append({
            "observation_id": detection_id, "event_id": detection_id,
            "title": f"Thermal detection · {abs(latitude):.2f}° {'S' if latitude < 0 else 'N'}, {abs(longitude):.2f}° {'W' if longitude < 0 else 'E'}",
            "kind": "Thermal detection", "latitude": latitude, "longitude": longitude,
            "observed_at": observed_at.isoformat(), "source_record": row,
        })
    return records, rejected


def optional_number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def public_observation(source, record, received_at):
    """The browser receives this consistent shape regardless of the source format."""
    raw = record["source_record"]
    observation = {
        "id": source + ":" + record["observation_id"],
        "eventId": record["event_id"], "source": SOURCE_NAMES[source],
        "title": record["title"], "kind": record["kind"],
        "longitude": record["longitude"], "latitude": record["latitude"],
        "observedAt": int(datetime.fromisoformat(record["observed_at"]).timestamp() * 1000),
        "receivedAt": int(datetime.fromisoformat(received_at).timestamp() * 1000),
        "updatedAt": None, "magnitude": None, "url": None,
    }
    if source == "usgs":
        properties = raw.get("properties") or {}
        coordinates = (raw.get("geometry") or {}).get("coordinates", [])
        observation.update({
            "magnitude": optional_number(properties.get("mag")),
            "depth": optional_number(coordinates[2]) if len(coordinates) > 2 else None,
            "updatedAt": optional_number(properties.get("updated")),
            "url": properties.get("url"), "status": properties.get("status") or "Not supplied",
        })
    elif source == "eonet":
        event = raw["event"]
        references = event.get("sources") or [{}]
        observation.update({
            "url": references[0].get("url") or event.get("link"),
            "status": "Closed by source" if event.get("closed") else "Open in EONET",
        })
    else:
        observation.update({
            "satellite": raw["satellite"], "instrument": "VIIRS",
            "confidence": {"n": "nominal", "h": "high", "l": "low"}.get(raw["confidence"].lower(), raw["confidence"].lower()),
            "frp": optional_number(raw.get("frp")),
            "brightness": optional_number(raw.get("bright_ti4")),
            "status": "Satellite thermal anomaly · not a confirmed wildfire",
            "url": "https://firms.modaps.eosdis.nasa.gov/map/#d:7days;@" + str(record["longitude"]) + "," + str(record["latitude"]) + ",9z",
        })
    return observation


def initialize_database(connection):
    connection.executescript("""
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS ingestion_runs (
            run_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            status TEXT NOT NULL,
            raw_path TEXT,
            accepted_count INTEGER,
            rejected_count INTEGER,
            error TEXT
        );
        CREATE TABLE IF NOT EXISTS observations (
            source TEXT NOT NULL,
            observation_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            title TEXT NOT NULL,
            kind TEXT NOT NULL,
            longitude REAL NOT NULL,
            latitude REAL NOT NULL,
            observed_at TEXT NOT NULL,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            PRIMARY KEY (source, observation_id)
        );
        CREATE TABLE IF NOT EXISTS observation_revisions (
            source TEXT NOT NULL,
            observation_id TEXT NOT NULL,
            revision_number INTEGER NOT NULL,
            payload_hash TEXT NOT NULL,
            received_at TEXT NOT NULL,
            run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
            payload_json TEXT NOT NULL,
            PRIMARY KEY (source, observation_id, revision_number)
        );
        CREATE INDEX IF NOT EXISTS observations_time ON observations(observed_at);
    """)
    # Upgrade the existing first-release database without discarding its history.
    columns = {row[1] for row in connection.execute("PRAGMA table_info(observations)")}
    if "display_json" not in columns:
        connection.execute("ALTER TABLE observations ADD COLUMN display_json TEXT")


def write_observations(connection, source, records, received_at, run_id):
    revisions_added = 0
    for record in records:
        raw_json = canonical_json(record["source_record"])
        payload_hash = hashlib.sha256(raw_json.encode("utf-8")).hexdigest()
        previous = connection.execute(
            "SELECT payload_hash FROM observations WHERE source = ? AND observation_id = ?",
            (source, record["observation_id"]),
        ).fetchone()

        # A second fetch updates last_seen_at, but creates no false revision.
        if previous is None or previous[0] != payload_hash:
            revision_number = connection.execute(
                "SELECT COALESCE(MAX(revision_number), 0) + 1 FROM observation_revisions WHERE source = ? AND observation_id = ?",
                (source, record["observation_id"]),
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO observation_revisions VALUES (?, ?, ?, ?, ?, ?, ?)",
                (source, record["observation_id"], revision_number, payload_hash, received_at, run_id, raw_json),
            )
            revisions_added += 1

        connection.execute("""
            INSERT INTO observations(source, observation_id, event_id, title, kind,
                longitude, latitude, observed_at, first_seen_at, last_seen_at, payload_hash, display_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source, observation_id) DO UPDATE SET
                event_id=excluded.event_id, title=excluded.title, kind=excluded.kind,
                longitude=excluded.longitude, latitude=excluded.latitude,
                observed_at=excluded.observed_at, last_seen_at=excluded.last_seen_at,
                payload_hash=excluded.payload_hash, display_json=excluded.display_json
        """, (
            source, record["observation_id"], record["event_id"], record["title"], record["kind"],
            record["longitude"], record["latitude"], record["observed_at"],
            received_at, received_at, payload_hash,
            canonical_json(public_observation(source, record, received_at)),
        ))
    return revisions_added


def ingest(source, data_directory, input_file=None):
    data_directory.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(data_directory / "earthwatch.sqlite")
    initialize_database(connection)
    run_id = str(uuid.uuid4())
    connection.execute(
        "INSERT INTO ingestion_runs(run_id, source, started_at, status) VALUES (?, ?, ?, ?)",
        (run_id, source, utc_now(), "running"),
    )
    connection.commit()
    try:
        if input_file:
            raw_bytes = input_file.read_bytes()
        else:
            request = Request(SOURCES[source], headers={"User-Agent": "EarthWatch/0.2"})
            with urlopen(request, timeout=30) as response:
                raw_bytes = response.read()

        # Keep the original response even if parsing or validation subsequently fails.
        raw_directory = data_directory / "raw" / source
        raw_directory.mkdir(parents=True, exist_ok=True)
        raw_path = raw_directory / (run_id + (".csv" if source == "firms" else ".json"))
        raw_path.write_bytes(raw_bytes)
        connection.execute("UPDATE ingestion_runs SET raw_path = ? WHERE run_id = ?", (str(raw_path), run_id))
        connection.commit()

        payload = raw_bytes.decode("utf-8-sig") if source == "firms" else json.loads(raw_bytes)
        records, rejected = normalize(source, payload)
        if rejected and not records:
            raise ValueError("All source records were rejected; retaining the last successful observations")
        received_at = utc_now()
        # All accepted records and the success marker commit in one transaction.
        with connection:
            revisions = write_observations(connection, source, records, received_at, run_id)
            # This table represents the source's CURRENT window. Revisions retain
            # historical records, while disappeared records leave the serving table.
            accepted_ids = {record["observation_id"] for record in records}
            existing_ids = connection.execute("SELECT observation_id FROM observations WHERE source=?", (source,)).fetchall()
            for (observation_id,) in existing_ids:
                if observation_id not in accepted_ids:
                    connection.execute("DELETE FROM observations WHERE source=? AND observation_id=?", (source, observation_id))
            connection.execute(
                "UPDATE ingestion_runs SET finished_at=?, status=?, accepted_count=?, rejected_count=? WHERE run_id=?",
                (utc_now(), "succeeded", len(records), rejected, run_id),
            )
        return {"run_id": run_id, "source": source, "accepted": len(records), "rejected": rejected, "revisions_added": revisions}
    except Exception as error:
        connection.rollback()
        with connection:
            connection.execute(
                "UPDATE ingestion_runs SET finished_at=?, status=?, error=? WHERE run_id=?",
                (utc_now(), "failed", str(error), run_id),
            )
        raise
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description="Preserve, validate and ingest real EarthWatch source data.")
    parser.add_argument("--source", choices=SOURCES, default="usgs")
    parser.add_argument("--input", type=Path, help="Replay an existing raw response instead of requesting the source")
    parser.add_argument("--data-dir", type=Path, default=PROJECT_ROOT / "data")
    arguments = parser.parse_args()
    result = ingest(arguments.source, arguments.data_dir, arguments.input)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
