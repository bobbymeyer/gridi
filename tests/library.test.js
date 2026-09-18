// The patches that ship with Gridi.
//
// A library patch is an ordinary saved file, so the risk is not that the format
// drifts -- it is that a change to the geometry or the grid silently retimes a
// patch nobody plays until later. These read the files as the app does and
// check the timing that makes them what they are.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readPatch, outgoing, nodeById } from '../src/model.js';
import { lineCells } from '../src/geometry.js';
import { gridBeats } from '../src/rhythm.js';

const read = (file) => readFileSync(new URL(`../patches/${file}`, import.meta.url), 'utf8');
const index = JSON.parse(read('index.json'));

/** Every line out of a node, in cells, shortest first. */
function branches(patch, node) {
  return outgoing(patch, node.id)
    .map((l) => lineCells(node, nodeById(patch, l.to)))
    .sort((a, b) => a - b);
}

test('the library index lists patches, and every one of them opens', () => {
  assert.ok(Array.isArray(index.patches) && index.patches.length, 'the library is not empty');
  for (const entry of index.patches) {
    assert.match(entry.file, /^[\w-]+\.json$/, 'a plain filename, fetched as a path');
    assert.ok(entry.name, `${entry.file} has a name`);
    const patch = readPatch(read(entry.file));
    assert.ok(patch, `${entry.file} opens`);
    assert.ok(patch.nodes.length > 0, `${entry.file} has nodes`);
    assert.ok(patch.lines.length > 0, `${entry.file} has lines`);
    assert.equal(patch.name, entry.name, `${entry.file} calls itself what the index calls it`);
  }
});

test('every library patch is wired up, with nothing left dangling', () => {
  for (const entry of index.patches) {
    const patch = readPatch(read(entry.file));
    const ids = new Set(patch.nodes.map((n) => n.id));
    for (const line of patch.lines) {
      assert.ok(ids.has(line.from) && ids.has(line.to), `${entry.file} has a line to nowhere`);
    }
    for (const node of patch.nodes) {
      const wired = patch.lines.some((l) => l.from === node.id || l.to === node.id);
      assert.ok(wired, `${entry.file} leaves a ${node.type} unpatched`);
    }
  }
});

test('the bossa comp is drawn on the clave', () => {
  const patch = readPatch(read('bossa-nova.json'));
  assert.equal(patch.grid, '1/16', 'a cell is a sixteenth, which is what the offsets are counted in');
  const split = patch.nodes.find((n) => n.type === 'split');
  const hits = branches(patch, split);
  assert.equal(hits.length, 5, 'five hits to a turn of the clave');
  // Bossa clave, 3-2: three hits in the first bar, two in the second.
  assert.deepEqual(hits.map((c) => c - hits[0]), [0, 6, 12, 20, 28]);
});

test('the bossa parts are in phase with each other', () => {
  const patch = readPatch(read('bossa-nova.json'));
  const cell = gridBeats(patch.grid);

  /** Beats between an emitter firing and the first thing it feeds sounding. */
  const latency = (node) => {
    let total = 0;
    let here = node;
    for (let hop = 0; hop < 8; hop += 1) {
      const next = outgoing(patch, here.id)[0];
      if (!next) break;
      const to = nodeById(patch, next.to);
      total += lineCells(here, to);
      here = to;
    }
    return total * cell;
  };

  const by = (type) => patch.nodes.filter((n) => n.type === 'pulse')
    .find((n) => {
      let here = n;
      for (let hop = 0; hop < 8; hop += 1) {
        const next = outgoing(patch, here.id)[0];
        if (!next) return false;
        here = nodeById(patch, next.to);
        if (here.type === type) return true;
      }
      return false;
    });

  const comp = latency(by('split'));   // the clave, and what everything else answers to
  const bass = latency(by('router'));
  const top = latency(by('chance'));
  const key = latency(by('key'));

  // Each part is late by its own chain, which is fine as long as the lateness
  // is a whole number of that part's own cycles: then the phases agree and the
  // only thing the extra distance costs is a later entry on the first pass.
  const cycles = (beats, cycle) => Math.abs(beats / cycle - Math.round(beats / cycle));
  assert.ok(cycles(bass - comp, 4) < 1e-9, `bass is ${bass - comp} beats off, not a whole root-fifth cycle`);
  assert.ok(cycles(top - comp, 8) < 1e-9, `melody is ${top - comp} beats off, not a whole Euclid cycle`);

  // The key change is pulled a sixteenth ahead of the comp, so the chord is
  // already in place when the bar's first chord tone fires.
  assert.ok(Math.abs(comp - key - 0.25) < 1e-9, `the key lands ${comp - key} beats early, wanted 0.25`);
});
