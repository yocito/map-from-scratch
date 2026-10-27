import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readRange } from '../../examples/24-osm-planet/pmtiles.ts';

test('HTTP 200 is cancelled before retrying a byte range', async () => {
  let calls = 0, cancelled = false;
  const fetcher = async (_url: string, _options: RequestInit) => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 });
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 206, headers: { 'Content-Range': 'bytes 10-13/100' } });
  };
  const bytes = await readRange(10, 4, fetcher as typeof fetch);
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
  assert.equal(calls, 2);
  assert.equal(cancelled, true);
});

test('persistent HTTP 200 never reads the archive body', async () => {
  let cancelled = 0;
  const fetcher = async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 200 });
  await assert.rejects(readRange(0, 4, fetcher as typeof fetch), /Range/);
  assert.equal(cancelled, 4);
});
