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
import { Engine } from '../src/engine.js';
import { fakeAudio, fakeMidi } from './helpers.js';

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
    // A Param node names the node it modulates, and an id is minted fresh on
    // every build, so the reference is compared the way a line is: as a
    // position in the list rather than as a name.
    nodes: patch.nodes.map((n) => ({
      type: n.type,
      col: n.col,
      row: n.row,
      params: n.params.target ? { ...n.params, target: at.get(n.params.target) ?? null } : n.params,
    })),
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

/* ------------------------------------------------------- how they are played */

/** Every note a patch sends in `seconds` of playing, against a hand-driven clock. */
function play(patch, seconds, step = 0.02) {
  const audio = fakeAudio();
  const midi = fakeMidi();
  const engine = new Engine({ getPatch: () => patch, audio, midi });
  engine.start();
  for (let t = 0; t < seconds; t += step) {
    audio.t = t;
    engine.tick();
  }
  return midi.notes.filter((n) => n.at < seconds).sort((a, b) => a.at - b.at);
}

test('every library patch plays with a moving hand', () => {
  // A part played at one velocity is one sound for ever. Through a SoundFont
  // velocity reaches filter cutoff as well as loudness, so a flat part is not
  // merely undynamic, it is literally one timbre from the first bar to the
  // last — which is how these patches came to sound like a demo of a drum
  // machine rather than like anybody playing.
  for (const entry of index.patches) {
    const patch = readPatch(read(entry.file));
    const byChannel = new Map();
    for (const note of play(patch, 90)) {
      if (!byChannel.has(note.ch)) byChannel.set(note.ch, []);
      byChannel.get(note.ch).push(note.vel);
    }
    assert.ok(byChannel.size, `${entry.file} plays something`);
    for (const [ch, vels] of byChannel) {
      const levels = new Set(vels).size;
      assert.ok(levels >= 8, `${entry.file} plays channel ${ch} at ${levels} velocities, wanted 8 or more`);
      assert.ok(Math.max(...vels) - Math.min(...vels) >= 20,
        `${entry.file} keeps channel ${ch} inside ${Math.max(...vels) - Math.min(...vels)} velocities of itself`);
    }
  }
});

test('no library patch is the same bar twice', () => {
  // The point of the thing is that distance, chance and a drifting hand add up
  // to music that does not come round. A bar that is an exact repeat of an
  // earlier one -- every hit at the same place, on the same note, at the same
  // weight -- means something has stopped moving.
  for (const entry of index.patches) {
    const patch = readPatch(read(entry.file));
    const seconds = 90;
    const bar = (60 / patch.bpm) * 4;
    const notes = play(patch, seconds);
    const bars = Math.floor(seconds / bar);
    const seen = new Set();
    for (let b = 0; b < bars; b += 1) {
      seen.add(notes
        .filter((n) => n.at >= b * bar && n.at < (b + 1) * bar)
        .map((n) => `${Math.round(((n.at - b * bar) / bar) * 96)}:${n.ch}:${n.note}:${n.vel}`)
        .join(','));
    }
    const unique = (seen.size / bars) * 100;
    assert.ok(unique >= 90, `${entry.file} repeats: only ${unique.toFixed(0)}% of its ${bars} bars are new`);
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

/** Which General MIDI drum a Note node is striking, from the degree it fires. */
const drumNote = (node) => node.params.degree - 1 + 12 * (node.params.octave + 1);

/** A drum is a note on a line pinned chromatic, which is how the kit is played. */
const isDrumLine = (line) => line.scaleMode === 'set' && line.scale === 'chromatic';

/** The Split whose branches strike a given drum. */
function splitFor(patch, note) {
  return patch.nodes.find((n) => n.type === 'split'
    && outgoing(patch, n.id).some((l) => {
      const to = nodeById(patch, l.to);
      return isDrumLine(l) && to.type === 'note' && drumNote(to) === note;
    }));
}

/** The Split whose branches play on one MIDI channel. */
function splitOn(patch, ch) {
  return patch.nodes.find((n) => n.type === 'split'
    && outgoing(patch, n.id).every((l) => l.channels?.[0]?.ch === ch));
}

test('the samba is played on the bateria General MIDI actually has', () => {
  // The first version of this patch was a drum kit doing an impression: the
  // surdo was a low tom and the tamborim a tambourine. The standard kit has a
  // mute surdo, an open one, a cuíca and a cabasa at their own note numbers,
  // and the difference between those and a tom is the whole patch.
  const patch = readPatch(read('samba.json'));
  const struck = new Set(patch.lines
    .filter(isDrumLine)
    .map((l) => nodeById(patch, l.to))
    .filter((n) => n.type === 'note')
    .map(drumNote));
  for (const [name, note] of [
    ['mute surdo', 86], ['open surdo', 87], ['caixa', 38], ['cabasa', 69],
    ['high timbale', 65], ['high agogô', 67], ['low agogô', 68],
    ['mute cuíca', 78], ['open cuíca', 79],
  ]) {
    assert.ok(struck.has(note), `samba.json has nobody on the ${name}`);
  }
});

test('the samba tamborim is the figure it says it is', () => {
  const patch = readPatch(read('samba.json'));
  assert.deepEqual(figure(patch, splitFor(patch, 65)), [0, 2, 3, 5, 9, 11, 12, 14]);
});

test('the samba surdo is muffled on the one and open on the two', () => {
  const patch = readPatch(read('samba.json'));
  const split = splitFor(patch, 87);
  // Two branches a beat apart, on a part that comes round every half bar: the
  // mute stroke on the one of each 2/4 bar, the open one on its two, which is
  // where samba lands.
  assert.deepEqual(figure(patch, split), [0, 4]);
  const strokes = outgoing(patch, split.id)
    .map((l) => ({ node: nodeById(patch, l.to), cells: lineCells(split, nodeById(patch, l.to)) }))
    .sort((a, b) => a.cells - b.cells)
    .map(({ node }) => ({ note: drumNote(node), velocity: node.params.velocity }));
  assert.equal(strokes[0].note, 86, 'the nearer branch is the mute surdo');
  assert.equal(strokes[1].note, 87, 'and the further one, a beat later, is the open');
  assert.ok(strokes[1].velocity > strokes[0].velocity + 30, 'the open stroke is the loud one');
});

test('the samba cavaquinho chops off the beat', () => {
  const patch = readPatch(read('samba.json'));
  // A cavaquinho on the beat is a metronome. Its two chords a bar sit on the
  // second and the fourth sixteenth after it, which is the lean in samba.
  const comp = splitOn(patch, 3);
  assert.deepEqual(figure(patch, comp), [0, 3]);
  const clock = clockFor(patch, (n) => n.id === comp.id);
  const surdo = clockFor(patch, (n) => n.type === 'split' && n.id === splitFor(patch, 87).id);
  const gap = ((chain(patch, clock) - chain(patch, surdo)) % 8 + 8) % 8;
  assert.equal(gap, 3, 'three sixteenths after the surdo takes the bar');
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
