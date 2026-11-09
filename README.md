# EarthWatch

EarthWatch combines an interactive 3D globe with a scheduled observation pipeline for USGS earthquakes, NASA natural events, and satellite thermal detections in southern Africa.

## Features

- CesiumJS globe with Esri World Imagery, opening above southern Africa.
- Search, source layers, circular watch areas, and observation-time replay.
- Glowing markers and screen-space clusters for dense observations.
- Source provenance, observation age, retrieval timestamps, confidence and fire radiative power.
- Raw-response preservation, coordinate and timestamp validation, SQLite upserts and record revisions.
- Last-successful source records remain available after ingestion failures; source status and snapshot age expose delays.

## Run locally

Requirements: Python 3.12+, internet access, and a WebGL-capable browser. Node.js 22+ is required for tests and Blob publication. No pip dependencies or frontend build step are needed.

```sh
python pipeline/refresh.py
python -m http.server 8173 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:8173/. On Windows, `START-EARTHWATCH.cmd` starts the local server. Generate a local snapshot with the refresh command. Leave `dist/config.json` with an empty `snapshotUrl` for local data; hosted deployments use the public Blob URL instead.

## Architecture

```text
USGS JSON + NASA EONET JSON + NASA FIRMS CSV
  -> preserve original responses
  -> normalize and validate
  -> SQLite observations + revisions + ingestion runs
  -> export dist/data/observations.json
  -> browser validates, filters and renders the snapshot
```

See [architecture and data model](docs/architecture.md) and [deployment](DEPLOY.md).

## Data coverage

| Source | Coverage |
| --- | --- |
| USGS | Global M2.5+ earthquake feed, past week |
| NASA EONET | Reported point geometries, retrieved from the past month |
| NASA FIRMS | Public NOAA-20 VIIRS southern Africa 24-hour download |

FIRMS points are satellite thermal anomalies, not confirmed wildfires or fire boundaries. One satellite does not observe every fire. FRP is radiative power, not fire size. EONET locations represent reported geometry, not measured affected area. Source acquisition, reporting and processing delays vary.

Basemap imagery and scenic lighting are not live. Marker glows are decorative. Replay filters the current snapshot by observation time; it does not reconstruct what an agency knew at a historical moment. The globe plots the newest 1,500 matching observations plus a selected older observation; the feed lists the newest 100. Counts and filters expose these rendering limits. This app is an observation explorer, not an emergency warning service.

## Verification

```sh
python -m unittest discover -s tests -p "test_*.py"
npm ci --ignore-scripts
npm test
python pipeline/verify_replay.py
```

The replay utility requires a successful USGS ingestion. It replays a saved response twice and verifies that another run does not duplicate observations or revisions.

## Deployment and retention

Vercel serves the static app in `dist/`. GitHub Actions runs the Python batch hourly, restoring SQLite from an Actions artifact. A small Node publisher replaces one public JSON object in Vercel Blob. The browser reads its URL from `dist/config.json` and checks for updates every five minutes while open. Data refreshes do not commit files or trigger website deployments. See [DEPLOY.md](DEPLOY.md) for setup.

Raw responses and revisions are retained for seven days, run logs for fourteen days. Only the two newest state artifacts are retained, each with a seven-day expiry. If no unexpired artifact is available, the database starts fresh. This retention model is not a permanent scientific archive. Generated snapshots, database/raw files and credentials are ignored by Git. Watch areas remain in each visitor's browser storage.

## Attribution

- [USGS feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php)
- [NASA EONET](https://eonet.gsfc.nasa.gov/docs/v3)
- [NASA FIRMS downloads](https://firms.modaps.eosdis.nasa.gov/active_fire/)
- [CesiumJS](https://cesium.com/platform/cesiumjs/), Apache 2.0
- Esri World Imagery: provider attribution remains displayed on the globe.
- DM Sans and IBM Plex Mono via Google Fonts.
