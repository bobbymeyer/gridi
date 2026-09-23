// The patches that ship with Gridi.
//
// A library patch is an ordinary saved file, so the risk is not that the format
// drifts -- it is that a change to the geometry or the grid silently retimes a
// patch nobody plays until later. These read the files as the app does and
// check the timing that makes them what they are.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readPatch, outgoing, nodeById, usedChannels, OPENING_PATCH } from '../src/model.js';
import { lineCells } from '../src/geometry.js';
import { gridBeats } from '../src/rhythm.js';
import { LIBRARY } from '../tools/build.mjs';
import { GM_KITS } from '../src/gm.js';

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

test('the patch gridi opens with is one the library ships', () => {
  // The opening patch is fetched from the library by name, so renaming the
  // file is enough to leave every first visit looking at the fallback demo
  // instead -- with nothing to say so but a swallowed fetch error.
  const entry = index.patches.find((p) => p.file === OPENING_PATCH);
  assert.ok(entry, `${OPENING_PATCH} is in the library index`);
  const patch = readPatch(read(entry.file));
  assert.ok(patch && patch.nodes.length, `${OPENING_PATCH} opens and has something on the grid`);
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

/* ------------------------------------------------- the files match the tools */

/**
 * A patch with its ids taken out.
 *
 * Node ids are minted fresh on every build, so two runs of the same builder are
 * never the same bytes. Everything that decides what a patch sounds like is
 * here: the settings, the nodes in order, and the lines as the pair of node
 * positions they join.
 */
function shape(patch) {
  const at = new Map(patch.nodes.map((n, i) => [n.id, i]));
  return JSON.stringify({
    name: patch.name,
    bpm: patch.bpm,
    sounds: patch.sounds,
    grid: patch.grid,
    root: patch.root,
    scale: patch.scale,
    nodes: patch.nodes.map((n) => ({ type: n.type, col: n.col, row: n.row, params: n.params })),
    lines: patch.lines.map((l) => ({
      from: at.get(l.from),
      to: at.get(l.to),
      channelMode: l.channelMode,
      channels: l.channels,
      scaleMode: l.scaleMode,
      scale: l.scale,
      root: l.root,
      delay: l.delay,
    })),
  }, null, 2);
}

test('every file in the library is what its builder produces', () => {
  assert.equal(LIBRARY.length, index.patches.length, 'the index lists every builder');
  for (const entry of LIBRARY) {
    const onDisk = readPatch(read(entry.file));
    assert.ok(onDisk, `${entry.file} opens`);
    assert.equal(
      shape(onDisk),
      shape(entry.build()),
      `${entry.file} is out of date -- run node tools/build.mjs`,
    );
  }
});

/* --------------------------------------------------------- what each one is */

/** Cells from an emitter to the first thing it feeds. */
function chain(patch, node) {
  let total = 0;
  let here = node;
  for (let hop = 0; hop < 8; hop += 1) {
    const next = outgoing(patch, here.id)[0];
    if (!next) break;
    const to = nodeById(patch, next.to);
    total += lineCells(here, to);
    here = to;
  }
  return total;
}

/** The emitter whose chain ends on a node the test can recognise. */
function clockFor(patch, matches) {
  return patch.nodes.filter((n) => n.type === 'pulse').find((n) => {
    let here = n;
    for (let hop = 0; hop < 8; hop += 1) {
      const next = outgoing(patch, here.id)[0];
      if (!next) return false;
      here = nodeById(patch, next.to);
      if (matches(here)) return true;
    }
    return false;
  });
}

/** Offsets of a Split's branches from its shortest one, in cells. */
function figure(patch, split) {
  const cells = outgoing(patch, split.id)
    .map((l) => lineCells(split, nodeById(patch, l.to)))
    .sort((a, b) => a - b);
  return cells.map((c) => c - cells[0]);
}

test('the samba tamborim is the figure it says it is', () => {
  const patch = readPatch(read('samba.json'));
  const split = patch.nodes.find((n) => n.type === 'split');
  assert.deepEqual(figure(patch, split), [0, 3, 6, 10, 12, 14]);
});

test('the samba surdo falls a beat later than the bar, on two and four', () => {
  const patch = readPatch(read('samba.json'));
  const isDrum = (note) => (n) => n.type === 'note' && n.params.degree === (note % 12) + 1;
  const surdo = clockFor(patch, isDrum(41));
  const tamborim = patch.nodes.find((n) => n.type === 'split');
  const tamClock = clockFor(patch, (n) => n.id === tamborim.id);
  // The surdo repeats every two bars, the tamborim every one. A beat between
  // them, however many whole cycles each has had to wait to be drawable.
  const gap = ((chain(patch, surdo) - chain(patch, tamClock)) % 16 + 16) % 16;
  assert.equal(gap, 4, 'a beat, which is what puts the surdo on two and four');
});

test('the house open hat is the kick clock, an eighth further out', () => {
  const patch = readPatch(read('house.json'));
  const isDrum = (note) => (n) => n.type === 'note' && n.params.degree === (note % 12) + 1;
  const kick = chain(patch, clockFor(patch, isDrum(36)));
  const hat = chain(patch, clockFor(patch, isDrum(46)));
  assert.equal(((hat - kick) % 4 + 4) % 4, 2, 'two cells of a four-cell beat');
});

test('the hip-hop kick is three hits off one clock', () => {
  const patch = readPatch(read('hiphop.json'));
  const split = patch.nodes.find((n) => n.type === 'split');
  assert.deepEqual(figure(patch, split), [0, 7, 10]);
});

test('the ambient loops share no factors, so the piece does not come round', () => {
  const patch = readPatch(read('ambient.json'));
  const lengths = patch.nodes
    .filter((n) => n.type === 'pulse')
    .map((n) => Math.round(n.params.ratioDen / n.params.ratioNum))
    .sort((a, b) => a - b);
  assert.deepEqual(lengths, [5, 7, 11, 13, 16]);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const lcm = lengths.reduce((a, b) => (a * b) / gcd(a, b));
  assert.equal(lcm, 80080, 'beats before the five of them line up again');
  assert.ok(lcm / patch.bpm / 60 > 20, `only ${(lcm / patch.bpm / 60).toFixed(1)} hours`);
});

/* ------------------------------------------------------------ sounds */

test('every library patch says what each of its channels should play', () => {
  for (const entry of index.patches) {
    const patch = readPatch(read(entry.file));
    const playing = usedChannels(patch);
    assert.ok(playing.length, `${entry.file} plays on something`);
    for (const { out, ch } of playing) {
      const sound = patch.sounds.find((s) => s.out === out && s.ch === ch);
      assert.ok(sound, `${entry.file} leaves ${out} channel ${ch} unnamed`);
      assert.ok(sound.program >= 0 && sound.program <= 127, `${entry.file} ch ${ch}`);
    }
    for (const sound of patch.sounds) {
      assert.ok(
        playing.some((c) => c.out === sound.out && c.ch === sound.ch),
        `${entry.file} names ${sound.out} channel ${sound.ch}, which nothing plays on`,
      );
    }
  }
});

test('the drum channel is given a kit, not an instrument', () => {
  for (const entry of index.patches) {
    const patch = readPatch(read(entry.file));
    const drums = patch.sounds.find((s) => s.ch === 10);
    if (!drums) continue;
    assert.ok(GM_KITS[drums.program], `${entry.file} asks for program ${drums.program} on channel 10`);
  }
});
