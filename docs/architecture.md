# Architecture and data model

## Ingestion

`pipeline/ingest.py` retrieves one public source, saves its original bytes, validates and normalizes records, and updates SQLite in a transaction. JSON and CSV parsing are source-specific. Latitude, longitude, identifiers and observation timestamps must be usable before a record is accepted. Invalid responses are preserved as raw files and recorded as failed runs.

## Record identity

`observations` holds one current observation per `(source, observation_id)` key. `observation_revisions` holds numbered source-record versions. `ingestion_runs` holds attempts, timestamps, counts and errors. An unchanged record updates its last-seen time without creating a duplicate revision. A record change appends a revision, including a change back to an earlier value. Successful empty source windows clear current records while retaining history within the retention window.

A USGS observation uses the source event identifier. FIRMS detections use a deterministic identity from satellite, instrument, acquisition time and coordinates. Multiple pixels may belong to the same physical fire; the pipeline does not infer incident identity.

## Serving

`pipeline/refresh.py` runs sources independently and atomically replaces `dist/data/observations.json`. The snapshot contains normalized observations and per-source retrieval status. A source failure preserves its last successful records and produces explicit failure metadata. In hosted runs the export is written to `work/observations.json`. `pipeline/publish.mjs` validates it again and overwrites `earthwatch/observations.json` in a public Vercel Blob store. The URL stays the same across refreshes. The write token exists only in the publication step's environment.

The frontend reads `dist/config.json`, then fetches the public URL and validates the snapshot before replacing its last working state. An empty URL selects the local generated file and labels it local. A configured remote URL never silently falls back to the local file. A failed fetch retains the browser's last loaded observations and shows an error. Blob caching is configured for 60 seconds; the visible browser polls every five minutes.

The static website deploys when its code or configuration changes. Hourly data updates do not create deployments. SQLite and raw responses live in bounded GitHub Actions artifacts, while Blob contains only the latest public export.

`dist/data.js` implements filtering, distance and age calculations. `dist/app.js` manages rendering, watch areas and interaction. Cesium handles geographic projection, camera navigation and screen-space clustering. Cluster counts refer to plotted observations, not physical fire incidents.

## Time semantics

- Observation time: timestamp reported by the source for an event or acquisition.
- Source update time: a source revision timestamp, when available.
- Retrieval time: when the pipeline received the response.
- Snapshot generation time: when the pipeline exported the serving file.

Observation-to-retrieval time includes any delay before ingestion; it is not necessarily the source's publication delay. Replay filters observations in the current snapshot by observation time. It is not an as-known-at reconstruction.

## Boundaries

Source coverage is heterogeneous and incomplete. EONET polygons are excluded rather than converted to invented points. FIRMS uses one satellite and region. Rendering is bounded to 1,500 recent matching points plus a selected observation, and 100 feed rows. Source records, raw responses, revision retention and visualisation each have different purposes and limits.
