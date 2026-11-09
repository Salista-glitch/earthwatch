import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(Path(__file__).parents[1] / "pipeline"))
import refresh


spec = importlib.util.spec_from_file_location("ingest", Path(__file__).parents[1] / "pipeline" / "ingest.py")
ingest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ingest)


class IngestionTests(unittest.TestCase):
    def test_raw_retention_uses_recorded_time_not_restored_file_mtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / 'usgs.json'
            fixture.write_text('{"features": []}', encoding='utf-8')
            result = ingest.ingest('usgs', root / 'data', fixture)
            old = (datetime.now(timezone.utc) - timedelta(days=9)).isoformat()
            with closing(sqlite3.connect(root / 'data' / 'earthwatch.sqlite')) as connection:
                connection.execute('UPDATE ingestion_runs SET started_at=? WHERE run_id=?', (old, result['run_id']))
                connection.commit()
            # The file itself has a NEW mtime, as it would after artifact extraction.
            refresh.prune_old_raw(root / 'data')
            self.assertEqual(list((root / 'data' / 'raw' / 'usgs').glob('*.json')), [])

    def test_firms_time_confidence_and_identity(self):
        header = 'latitude,longitude,acq_date,acq_time,satellite,confidence,frp\n'
        rows = '-33.9,18.4,2026-11-06,0030,N20,nominal,0\n'
        records, rejected = ingest.normalize('firms', header + rows)
        self.assertEqual(rejected, 0)
        self.assertIn('00:30:00', records[0]['observed_at'])
        first_id = records[0]['observation_id']
        revised, _ = ingest.normalize('firms', header + rows.replace('nominal,0', 'high,12.4'))
        self.assertEqual(first_id, revised[0]['observation_id'])
        display = ingest.public_observation('firms', records[0], '2026-11-06T01:00:00+00:00')
        self.assertEqual(display['frp'], 0)
        self.assertEqual(display['confidence'], 'nominal')
        self.assertEqual(display['source'], 'NASA FIRMS')

    def test_firms_rejects_html_bad_times_and_missing_locations(self):
        with self.assertRaises(ValueError):
            ingest.normalize('firms', '<html>server unavailable</html>')
        header = 'latitude,longitude,acq_date,acq_time,satellite,confidence\n'
        records, rejected = ingest.normalize('firms', header + ',18,2026-11-06,0030,N20,n\n-33,18,2026-11-06,2460,N20,n\n')
        self.assertEqual(records, [])
        self.assertEqual(rejected, 2)

    def test_export_preserves_failed_source_state_and_real_retrieval_time(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / 'firms.csv'
            fixture.write_text('latitude,longitude,acq_date,acq_time,satellite,confidence,frp\n-33,18,2026-11-06,0030,N20,n,2.5\n', encoding='utf-8')
            ingest.ingest('firms', root / 'data', fixture)
            fixture.write_text('<html>bad response</html>', encoding='utf-8')
            with self.assertRaises(ValueError):
                ingest.ingest('firms', root / 'data', fixture)
            exported = refresh.export_snapshot(root / 'data', root / 'public.json')
            self.assertEqual(len(exported['observations']), 1)
            status = next(item for item in exported['sources'] if item['name'] == 'NASA FIRMS')
            self.assertFalse(status['ok'])
            self.assertIsNotNone(status['receivedAt'])
            self.assertEqual(exported['schemaVersion'], 1)
            self.assertEqual(len(exported['sources']), 3)

    def test_successful_empty_window_removes_current_records_but_retains_revisions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / 'firms.csv'
            header = 'latitude,longitude,acq_date,acq_time,satellite,confidence\n'
            fixture.write_text(header + '-33,18,2026-11-06,0030,N20,n\n', encoding='utf-8')
            ingest.ingest('firms', root / 'data', fixture)
            fixture.write_text(header, encoding='utf-8')
            ingest.ingest('firms', root / 'data', fixture)
            with closing(sqlite3.connect(root / 'data' / 'earthwatch.sqlite')) as connection:
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM observations').fetchone()[0], 0)
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM observation_revisions').fetchone()[0], 1)

    def test_reruns_and_changed_records_preserve_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / "fixture.json"
            feature = {"id": "example", "properties": {"time": 1760000000000, "mag": 3, "place": "Example"}, "geometry": {"coordinates": [18, -33, 12]}}
            payload = {"features": [feature]}
            fixture.write_text(json.dumps(payload), encoding="utf-8")
            first = ingest.ingest("usgs", root / "data", fixture)
            second = ingest.ingest("usgs", root / "data", fixture)
            feature["properties"]["mag"] = 3.2
            fixture.write_text(json.dumps(payload), encoding="utf-8")
            third = ingest.ingest("usgs", root / "data", fixture)
            feature["properties"]["mag"] = 3
            fixture.write_text(json.dumps(payload), encoding="utf-8")
            reverted = ingest.ingest("usgs", root / "data", fixture)
            self.assertEqual([first["revisions_added"], second["revisions_added"], third["revisions_added"], reverted["revisions_added"]], [1, 0, 1, 1])
            with closing(sqlite3.connect(root / "data" / "earthwatch.sqlite")) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 1)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM observation_revisions").fetchone()[0], 3)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM ingestion_runs WHERE status='succeeded'").fetchone()[0], 4)

    def test_failed_payload_keeps_raw_and_does_not_replace_good_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / "bad.json"
            fixture.write_text('{"unexpected": []}', encoding="utf-8")
            with self.assertRaises(ValueError):
                ingest.ingest("usgs", root / "data", fixture)
            self.assertEqual(len(list((root / "data" / "raw" / "usgs").glob("*.json"))), 1)
            with closing(sqlite3.connect(root / "data" / "earthwatch.sqlite")) as connection:
                self.assertEqual(connection.execute("SELECT status FROM ingestion_runs").fetchone()[0], "failed")
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
