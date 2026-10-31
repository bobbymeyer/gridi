// Reading a response while it is still arriving.
//
// The SoundFont gridi ships with is thirty-two megabytes, and a bar drawn over
// that wait is only honest if the number behind it is. These check the three
// shapes a real response comes in: one that says how long it is, one that does
// not, and one with no stream to read at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWithProgress } from '../src/util.js';

/** A Response-alike that hands out `chunks` one read at a time. */
function streamed(chunks, { length = null } = {}) {
  let i = 0;
  const declared = length === null
    ? chunks.reduce((n, c) => n + c.length, 0)
    : length;
  return {
    headers: { get: (k) => (k === 'content-length' && declared ? String(declared) : null) },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { done: false, value: new Uint8Array(chunks[i++]) }
          : { done: true, value: undefined }),
      }),
    },
  };
}

test('a streamed body comes back whole, and counted on the way', async () => {
  const seen = [];
  const buffer = await readWithProgress(
    streamed([[1, 2, 3], [4, 5], [6]]),
    (loaded, total) => seen.push([loaded, total]),
  );
  assert.deepEqual([...new Uint8Array(buffer)], [1, 2, 3, 4, 5, 6]);
  // Zero first, so a bar is drawn empty rather than appearing part-done, and a
  // number after every chunk.
  assert.deepEqual(seen, [[0, 6], [3, 6], [5, 6], [6, 6]]);
});

test('a body that does not say how long it is reports a total of zero', async () => {
  // Chunked, or compressed on the way: there is no length to divide by, and a
  // caller has to be told that rather than shown a bar that cannot move.
  const seen = [];
  await readWithProgress(streamed([[1, 2], [3]], { length: 0 }), (l, t) => seen.push([l, t]));
  assert.deepEqual(seen, [[0, 0], [2, 0], [3, 0]]);
});

test('an empty chunk is not news', async () => {
  const seen = [];
  const buffer = await readWithProgress(streamed([[1], [], [2]]), (l) => seen.push(l));
  assert.deepEqual([...new Uint8Array(buffer)], [1, 2]);
  assert.deepEqual(seen, [0, 1, 2]);
});

test('a body with no stream falls back to reading it in one go', async () => {
  // Some fetches hand back a Response with no `body` at all. Loading the font
  // matters more than drawing the bar, so this reads it the old way and reports
  // the one number it has.
  const seen = [];
  const whole = Uint8Array.from([7, 8, 9]);
  const buffer = await readWithProgress({
    headers: { get: () => null },
    arrayBuffer: async () => whole.buffer,
  }, (loaded, total) => seen.push([loaded, total]));
  assert.deepEqual([...new Uint8Array(buffer)], [7, 8, 9]);
  assert.deepEqual(seen, [[3, 3]]);
});

test('reading a body needs no progress handler', async () => {
  const buffer = await readWithProgress(streamed([[1, 2]]));
  assert.equal(buffer.byteLength, 2);
});
