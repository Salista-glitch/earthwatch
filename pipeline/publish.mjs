// Upload only the public export. SQLite and raw responses stay in Actions artifacts.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { put } from '@vercel/blob';
import data from '../dist/data.js';

export async function publishSnapshot(body, token, upload = put) {
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required.');
  // Apply the same validation as the browser before replacing the working export.
  data.readSnapshot(JSON.parse(body));
  const blob = await upload('earthwatch/observations.json', body, {
    access: 'public',
    token,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
  return blob.url;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const body = await readFile(process.argv[2] || 'work/observations.json', 'utf8');
    const url = await publishSnapshot(body, process.env.BLOB_READ_WRITE_TOKEN);
    console.log('Public snapshot URL: ' + url);
  } catch {
    // Do not print SDK request details that could contain credentials.
    console.error('Snapshot publication failed. Check the export, Blob store access and BLOB_READ_WRITE_TOKEN.');
    process.exitCode = 1;
  }
}
