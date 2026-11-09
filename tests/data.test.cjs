const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sandbox = { URL, module: { exports: {} } };
vm.runInNewContext(fs.readFileSync('dist/data.js', 'utf8'), sandbox);
const data = sandbox.module.exports;

test('reject invalid or missing coordinates rather than drawing them at zero', () => {
  const payload = { features: [
    { id: 'missing', geometry: { coordinates: [null, null] }, properties: { time: 1 } },
    { id: 'bad', geometry: { coordinates: [220, -30] }, properties: { time: 1 } },
    { id: 'valid', geometry: { coordinates: [18, -33, 12] }, properties: { time: 1, mag: 0 } }
  ] };
  const result = data.normalizeQuakes(payload, 2);
  assert.equal(result.length, 1);
  assert.equal(result[0].magnitude, 0);
  assert.equal(result[0].longitude, 18);
});

test('replay cutoff uses observation time, not retrieval time', () => {
  const result = data.filterObservations([
    { source: 'USGS', title: 'Early', kind: 'Earthquake', observedAt: 10, receivedAt: 100 },
    { source: 'USGS', title: 'Late', kind: 'Earthquake', observedAt: 30, receivedAt: 100 }
  ], { start: 0, end: 20, quakes: true, events: true });
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'Early');
});

test('watch-area distance crosses the antimeridian correctly', () => {
  assert.ok(data.distanceKm(0, 179.9, 0, -179.9) < 23);
  const result = data.filterObservations([
    { source: 'USGS', observedAt: 10, latitude: 0, longitude: -179.9, title: 'Across date line', kind: '' }
  ], { start: 0, end: 20, quakes: true, area: { latitude: 0, longitude: 179.9, radius: 30 } });
  assert.equal(result.length, 1);
});

test('EONET preserves dated point observations and rejects polygon shortcuts', () => {
  const result = data.normalizeEvents({ events: [{ id: 'E1', title: 'Test', geometry: [
    { type: 'Point', date: '2026-01-01T00:00:00Z', coordinates: [18, -33] },
    { type: 'Point', date: '2026-01-02T00:00:00Z', coordinates: [19, -33] },
    { type: 'Polygon', date: '2026-01-01T00:00:00Z', coordinates: [[[0, 0]]] }
  ] }] }, 123);
  assert.equal(result.length, 2);
  assert.notEqual(result[0].id, result[1].id);
});

test('external links cannot execute scripts', () => {
  assert.equal(data.safeLink('javascript:alert(1)'), null);
  assert.equal(data.safeLink('https://www.usgs.gov/'), 'https://www.usgs.gov/');
});

test('observation age uses the observation clock and handles zero or future ages', () => {
  assert.equal(data.ageLabel(0, 0), 'Less than a minute');
  assert.equal(data.ageLabel(0, 90 * 60000), '1 h 30 min');
  assert.equal(data.ageLabel(0, 25 * 3600000), '1 d 1 h');
  assert.equal(data.ageLabel(100, 0), 'Future source timestamp');
});

test('thermal observations have an independent layer switch', () => {
  const observations = [{ source: 'NASA FIRMS', title: 'Thermal detection', kind: 'Thermal detection', observedAt: 1 }];
  assert.equal(data.filterObservations(observations, { start: 0, end: 2, fires: false }).length, 0);
  assert.equal(data.filterObservations(observations, { start: 0, end: 2, fires: true }).length, 1);
});

test('snapshot validation rejects missing sources and invalid coordinates', () => {
  const payload = { schemaVersion: 1, generatedAt: 1, sources: [], observations: [] };
  assert.throws(() => data.readSnapshot(payload));
  payload.sources = ['USGS', 'NASA EONET', 'NASA FIRMS'].map(name => ({ name, ok: false, receivedAt: null }));
  assert.equal(data.readSnapshot(payload).observations.size, 0);
  payload.observations.push({ id: 'x', title: 'x', kind: 'x', source: 'NASA FIRMS', latitude: null, longitude: 18, observedAt: 1, receivedAt: 2 });
  assert.throws(() => data.readSnapshot(payload));
});
