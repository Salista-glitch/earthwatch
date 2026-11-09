import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishSnapshot } from '../pipeline/publish.mjs';

const snapshot = JSON.stringify({
  schemaVersion: 1, generatedAt: 100, observations: [],
  sources: ['USGS', 'NASA EONET', 'NASA FIRMS'].map(name => ({ name, ok: true, receivedAt: 100 }))
});

test('successive refreshes replace the same public object without random filenames', async () => {
  const calls = [];
  const upload = async (...args) => { calls.push(args); return { url: 'https://example.public.blob.vercel-storage.com/earthwatch/observations.json' }; };
  const url = await publishSnapshot(snapshot, 'test-token', upload);
  await publishSnapshot(snapshot, 'test-token', upload);
  assert.equal(calls.length, 2);
  for (const [path, body, options] of calls) {
    assert.equal(path, 'earthwatch/observations.json');
    assert.equal(body, snapshot);
    assert.equal(options.addRandomSuffix, false);
    assert.equal(options.allowOverwrite, true);
    assert.equal(options.access, 'public');
    assert.equal(options.cacheControlMaxAge, 60);
  }
  assert.ok(url.endsWith('/earthwatch/observations.json'));
});

test('invalid exports and missing credentials never replace the working object', async () => {
  let uploads = 0;
  const upload = async () => { uploads++; };
  await assert.rejects(publishSnapshot('{}', 'test-token', upload));
  await assert.rejects(publishSnapshot(snapshot, '', upload));
  const malformed = JSON.parse(snapshot);
  malformed.observations.push({ id: 'bad', longitude: 200 });
  await assert.rejects(publishSnapshot(JSON.stringify(malformed), 'test-token', upload));
  assert.equal(uploads, 0);
});

test('a failed upload is reported as failure', async () => {
  await assert.rejects(publishSnapshot(snapshot, 'test-token', async () => { throw new Error('network unavailable'); }));
});
