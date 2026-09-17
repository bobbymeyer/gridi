import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, parseKeySteps, parseValues } from '../src/engine.js';
import { createPatch, createNode, addNode, connect, createChannel } from '../src/model.js';
import { fakeMidi, fakeAudio } from './helpers.js';
import { lineCells } from '../src/geometry.js';
import { gridBeats } from '../src/rhythm.js';

/**
 * Seconds a pulse spends walking a chain of nodes.
 *
 * Distance is time now, so every test that names an absolute onset has to say
 * how far the pulse travelled to get there. Tests that only care about the
 * interval between notes do not: a constant latency cancels out. They just
 * need a window long enough to catch the notes, which is why several of them
 * run for `walk(...)` seconds longer than the span they assert over.
 */
function walk(p, ...nodes) {
  let beats = 0;
  for (let i = 1; i < nodes.length; i += 1) {
    beats += lineCells(nodes[i - 1], nodes[i]) * gridBeats(p.grid);
  }
  return (beats * 60) / p.bpm;
}

/** Drives the engine with a fake clock so scheduling is deterministic. */
function run(patch, seconds, { step = 0.02 } = {}) {
  const audio = fakeAudio();
  const midi = fakeMidi();
  const pulses = [];
  const engine = new Engine({ getPatch: () => patch, audio, midi, onPulse: (p) => pulses.push(p) });
  engine.start();
  for (let t = 0; t < seconds; t += step) {
    audio.t = t;
    engine.tick();
  }
  // The look-ahead always schedules a little past the window; count only what
  // lands inside it so assertions do not depend on LOOKAHEAD.
  return {
    notes: midi.notes.filter((n) => n.at < seconds),
    pulses: pulses.filter((p) => p.arriveTime < seconds),
    audio,
    midi,
    engine,
  };
}

function basicPatch(pulseParams = {}, noteParams = {}) {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  p.root = 0;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4', ...pulseParams }));
  const note = addNode(p, createNode('note', 10, 0, { degree: 1, octave: 4, ...noteParams }));
  const line = connect(p, clock.id, note.id);
  return { p, clock, note, line };
}

test('a clock drives a note node at the right rate', () => {
  const { p, clock, note } = basicPatch();
  // Four cells of line between the two, an eighth note each: a beat of travel.
  const lat = walk(p, clock, note);
  assert.ok(Math.abs(lat - 1) < 1e-9, `four cells at 1/8 is a bar, got ${lat}s`);
  const { notes } = run(p, 2 + lat);
  // 120bpm, 1/4 notes -> every 0.5s, starting at the 0.08s anchor.
  assert.ok(notes.length >= 4, `got ${notes.length}`);
  assert.ok(Math.abs(notes[0].at - (0.08 + lat)) < 1e-6);
  assert.ok(Math.abs(notes[1].at - notes[0].at - 0.5) < 1e-6);
  assert.equal(notes[0].note, 60); // C4
  assert.equal(notes[0].ch, 1);
});

test('tempo sets the interval', () => {
  const { p, clock, note } = basicPatch();
  p.bpm = 60;
  const { notes } = run(p, 3 + walk(p, clock, note));
  assert.ok(Math.abs(notes[1].at - notes[0].at - 1) < 1e-6);
});

test('an inactive emitter is silent', () => {
  const { p } = basicPatch({ running: false });
  assert.equal(run(p, 2).notes.length, 0);
});

test('swing pushes the off-beats late', () => {
  const { p, clock, note } = basicPatch({ division: '1/8', swing: 0.4 });
  const { notes } = run(p, 1.2 + walk(p, clock, note));
  const first = notes[1].at - notes[0].at;
  const second = notes[2].at - notes[1].at;
  assert.ok(first > second, 'long-short pairing expected');
});

test('euclid gating thins the clock out', () => {
  const { p, clock, note } = basicPatch({ division: '1/4', euclidOn: true, euclidPulses: 2, euclidSteps: 4 });
  const { notes } = run(p, 4 + walk(p, clock, note));
  // E(2,4) is x.x. -> half the quarter notes, across two bars.
  assert.equal(notes.length, 4);
});

test('a line carrying several channels fans one pulse across all of them', () => {
  const { p, clock, note, line } = basicPatch();
  line.channelMode = 'set';
  line.channels = [createChannel(1), createChannel(5), createChannel(11)];
  const { notes } = run(p, 1.1 + walk(p, clock, note));
  const firstHit = notes.filter((n) => Math.abs(n.at - notes[0].at) < 1e-9);
  assert.deepEqual(firstHit.map((n) => n.ch), [1, 5, 11]);
  assert.deepEqual(new Set(firstHit.map((n) => n.note)), new Set([60]));
});

test('per-channel transpose rides on the line', () => {
  const { p, clock, note, line } = basicPatch();
  line.channelMode = 'set';
  line.channels = [createChannel(1), { ...createChannel(2), transpose: -12, velocity: 40 }];
  const { notes } = run(p, 0.6 + walk(p, clock, note));
  assert.equal(notes[0].note, 60);
  assert.equal(notes[1].note, 48);
  assert.equal(notes[1].vel, 40);
});

test('a scale set on the line overrides the project key', () => {
  const { p, clock, note, line } = basicPatch();
  p.scale = 'minPent';
  p.root = 9; // A minor pentatonic
  note.params.degree = 3;
  const window = 0.6 + walk(p, clock, note);
  const projectAnswer = run(p, window).notes[0].note;

  line.scaleMode = 'set';
  line.scale = 'major';
  line.root = 0;
  const lineAnswer = run(p, window).notes[0].note;

  assert.equal(lineAnswer, 64); // E4, the 3rd of C major
  assert.notEqual(lineAnswer, projectAnswer);
});

test('line delay is a trim on top of what the distance already costs', () => {
  const { p, clock, note, line } = basicPatch();
  const lat = walk(p, clock, note);
  line.delay = 0.5; // beats -> 0.25s at 120bpm, added to the travel time
  const { notes } = run(p, 1.2 + lat);
  assert.ok(Math.abs(notes[0].at - (0.08 + lat + 0.25)) < 1e-6);
  assert.ok(Math.abs(notes[1].at - notes[0].at - 0.5) < 1e-6, 'rate is unchanged');
});

test('a muted line stops passing pulses', () => {
  const { p, line } = basicPatch();
  line.muted = true;
  assert.equal(run(p, 2).notes.length, 0);
});

test('split leaves down every branch at once, and each lands by its own distance', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const split = addNode(p, createNode('split', 10, 0));
  const a = addNode(p, createNode('note', 20, 0, { degree: 1, octave: 4 }));
  // b sits a row down, so its line is longer and its note lands later. A split
  // still fires both branches on the same instant; the grid is what separates
  // them. Laying the two out level is how you get them back together.
  const b = addNode(p, createNode('note', 20, 8, { degree: 5, octave: 4 }));
  connect(p, clock.id, split.id);
  connect(p, split.id, a.id);
  connect(p, split.id, b.id);
  const { notes } = run(p, 1.1 + walk(p, clock, split, b));
  const hitA = notes.find((n) => n.note === 60);
  const hitB = notes.find((n) => n.note === 67);
  assert.ok(hitA && hitB, 'both branches sound');
  assert.ok(Math.abs(hitA.at - (0.08 + walk(p, clock, split, a))) < 1e-6);
  assert.ok(Math.abs(hitB.at - (0.08 + walk(p, clock, split, b))) < 1e-6);
  assert.ok(hitB.at > hitA.at, 'the longer branch is the later one');
});

test('split stagger flams the branches', () => {
  const p = createPatch('t');
  p.bpm = 120;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  p.scale = 'major';
  const split = addNode(p, createNode('split', 10, 0, { stagger: 0.25 }));
  const a = addNode(p, createNode('note', 20, 0, { degree: 1, octave: 4 }));
  const b = addNode(p, createNode('note', 20, 8, { degree: 5, octave: 4 }));
  connect(p, clock.id, split.id);
  connect(p, split.id, a.id);
  connect(p, split.id, b.id);
  // Stagger is added to what each branch already costs in distance.
  const { notes } = run(p, 1.1 + walk(p, clock, split, b));
  const hitA = notes.find((n) => n.note === 60);
  const hitB = notes.find((n) => n.note === 67);
  const base = 0.08 + walk(p, clock, split);
  assert.ok(Math.abs(hitA.at - (base + walk(p, split, a))) < 1e-6, 'first branch is unstaggered');
  assert.ok(Math.abs(hitB.at - (base + walk(p, split, b) + 0.125)) < 1e-6, 'second is a 1/4 beat late');
});

test('router sends each pulse down exactly one line', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const router = addNode(p, createNode('router', 10, 0, { mode: 'cycle' }));
  const a = addNode(p, createNode('note', 20, 0, { degree: 1, octave: 4 }));
  const b = addNode(p, createNode('note', 20, 8, { degree: 2, octave: 4 }));
  const c = addNode(p, createNode('note', 20, 16, { degree: 3, octave: 4 }));
  connect(p, clock.id, router.id);
  connect(p, router.id, a.id);
  connect(p, router.id, b.id);
  connect(p, router.id, c.id);
  // The three branches are different lengths, so arrival order is not routing
  // order. Subtracting each branch's travel gives the moment it left.
  const leg = { 60: walk(p, router, a), 62: walk(p, router, b), 64: walk(p, router, c) };
  const feed = walk(p, clock, router); // the pulse reaches the router this late
  const { notes } = run(p, 2 + feed + Math.max(...Object.values(leg)));
  const sent = notes
    .map((n) => ({ note: n.note, left: n.at - leg[n.note] - feed }))
    .filter((n) => n.left < 2)
    .sort((x, y) => x.left - y.left);
  assert.equal(sent.length, 4, 'one note per pulse, never two');
  assert.deepEqual(sent.map((n) => n.note), [60, 62, 64, 60]);
});

test('router ping-pong walks up and back', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const router = addNode(p, createNode('router', 10, 0, { mode: 'pingpong' }));
  const leg = {};
  for (const d of [1, 2, 3]) {
    const n = addNode(p, createNode('note', 20, d * 8, { degree: d, octave: 4 }));
    connect(p, router.id, n.id);
    leg[[60, 62, 64][d - 1]] = walk(p, router, n);
  }
  connect(p, clock.id, router.id);
  const { notes } = run(p, 3.1 + Math.max(...Object.values(leg)));
  const sent = notes
    .map((n) => ({ note: n.note, left: n.at - leg[n.note] }))
    .sort((x, y) => x.left - y.left)
    .map((n) => n.note);
  assert.deepEqual(sent.slice(0, 5), [60, 62, 64, 62, 60]);
});

test('probability gate at 0 and 100 is deterministic', () => {
  const build = (probability) => {
    const p = createPatch('t');
    p.bpm = 120;
    const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
    const chance = addNode(p, createNode('chance', 10, 0, { probability }));
    const note = addNode(p, createNode('note', 20, 0));
    connect(p, clock.id, chance.id);
    connect(p, chance.id, note.id);
    return p;
  };
  assert.equal(run(build(0), 2).notes.length, 0);
  const open = build(100);
  assert.ok(run(open, 2 + walk(open, ...open.nodes)).notes.length >= 4);
});

test('probability is reproducible for a given seed', () => {
  const build = (seed) => {
    const p = createPatch('t');
    p.bpm = 120;
    p.seed = seed;
    const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/16' }));
    const chance = addNode(p, createNode('chance', 10, 0, { probability: 50 }));
    const note = addNode(p, createNode('note', 20, 0));
    connect(p, clock.id, chance.id);
    connect(p, chance.id, note.id);
    return p;
  };
  const a = run(build(7), 3).notes.map((n) => n.at.toFixed(4)).join();
  const b = run(build(7), 3).notes.map((n) => n.at.toFixed(4)).join();
  const c = run(build(8), 3).notes.map((n) => n.at.toFixed(4)).join();
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('AND gate needs both inputs inside the window', () => {
  const p = createPatch('t');
  p.bpm = 120;
  const fast = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const slow = addNode(p, createNode('pulse', 0, 16, { division: '1/2' }));
  // Both feeds are the same length, so their pulses still land together.
  const gate = addNode(p, createNode('gate', 10, 8, { mode: 'all', windowMs: 20 }));
  const note = addNode(p, createNode('note', 20, 8));
  connect(p, fast.id, gate.id);
  connect(p, slow.id, gate.id);
  connect(p, gate.id, note.id);
  const { notes } = run(p, 4 + walk(p, fast, gate, note));
  // The slow clock only coincides every other quarter note.
  assert.equal(notes.length, 4);
  for (let i = 1; i < notes.length; i += 1) {
    assert.ok(Math.abs(notes[i].at - notes[i - 1].at - 1) < 0.03);
  }
});

test('OR gate passes anything that arrives', () => {
  const p = createPatch('t');
  p.bpm = 120;
  const fast = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const slow = addNode(p, createNode('pulse', 0, 16, { division: '1/2' }));
  // Both feeds are the same length, so their pulses still land together.
  const gate = addNode(p, createNode('gate', 10, 8, { mode: 'any' }));
  const note = addNode(p, createNode('note', 20, 8));
  connect(p, fast.id, gate.id);
  connect(p, slow.id, gate.id);
  connect(p, gate.id, note.id);
  const { notes } = run(p, 2 + walk(p, fast, gate, note));
  assert.equal(notes.length, 6); // 4 fast + 2 slow
});

test('XOR gate rejects coincidence', () => {
  const p = createPatch('t');
  p.bpm = 120;
  const fast = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const slow = addNode(p, createNode('pulse', 0, 16, { division: '1/2' }));
  // Both feeds are the same length, so their pulses still land together.
  const gate = addNode(p, createNode('gate', 10, 8, { mode: 'xor', windowMs: 20 }));
  const note = addNode(p, createNode('note', 20, 8));
  connect(p, fast.id, gate.id);
  connect(p, slow.id, gate.id);
  connect(p, gate.id, note.id);
  const { notes } = run(p, 4 + walk(p, fast, gate, note));
  assert.equal(notes.length, 4); // only the off-beats, where the slow clock is absent
});

test('a latching key node modulates the whole project live', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  p.root = 0;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const key = addNode(p, createNode('key', 10, 0, {
    mode: 'cycle',
    steps: '0:major 7:major',
    latch: true,
  }));
  const note = addNode(p, createNode('note', 20, 0, { degree: 1, octave: 4 }));
  connect(p, clock.id, key.id);
  connect(p, key.id, note.id);
  const { notes } = run(p, 2 + walk(p, clock, key, note));
  assert.deepEqual(notes.slice(0, 4).map((n) => n.note), [60, 67, 60, 67]);
});

test('a latching key node rewrites the project key itself', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  p.root = 0;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const key = addNode(p, createNode('key', 10, 0, {
    mode: 'set',
    root: 5,
    scale: 'dorian',
    latch: true,
  }));
  connect(p, clock.id, key.id);
  run(p, 0.6 + walk(p, clock, key));
  assert.equal(p.root, 5);
  assert.equal(p.scale, 'dorian');
});

test('a key change reaches only what is downstream of it', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  p.root = 0;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const split = addNode(p, createNode('split', 10, 0));
  const key = addNode(p, createNode('key', 20, 0, { mode: 'set', root: 5, scale: 'major' }));
  const shifted = addNode(p, createNode('note', 30, 0, { degree: 1, octave: 4 }));
  const untouched = addNode(p, createNode('note', 20, 12, { degree: 1, octave: 4 }));
  connect(p, clock.id, split.id);
  connect(p, split.id, key.id);
  connect(p, key.id, shifted.id);
  connect(p, split.id, untouched.id);
  // The two branches are different lengths; wait for the slower of them.
  const reach = Math.max(walk(p, clock, split, key, shifted), walk(p, clock, split, untouched));
  const { notes } = run(p, 0.6 + reach);
  assert.deepEqual(new Set(notes.map((n) => n.note)), new Set([60, 65]));
});

test('a param node steps a target parameter', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  p.root = 0;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const note = addNode(p, createNode('note', 20, 0, { degree: 1, octave: 4 }));
  const mod = addNode(p, createNode('param', 10, 0, {
    scope: 'node',
    target: note.id,
    param: 'degree',
    mode: 'sequence',
    values: '1 3 5',
  }));
  connect(p, clock.id, mod.id);
  connect(p, mod.id, note.id);
  // A node-scope Param writes to the target when the pulse passes the Param,
  // and the target reads that value when its own pulse arrives -- which the
  // line between them now makes a later moment. The sequence still cycles; it
  // runs at a phase set by the distance, so a Param wants to sit next to what
  // it modulates. The opening notes are the pulses already in flight.
  const { notes } = run(p, 7 + walk(p, clock, mod, note));
  const settled = notes.filter((n) => n.at > 4).slice(0, 6);
  assert.deepEqual(settled.map((n) => n.note), [60, 64, 67, 60, 64, 67]);
});

test('a signal-scope param node rides with the pulse', () => {
  const p = createPatch('t');
  p.bpm = 120;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4', velocity: 100 }));
  const mod = addNode(p, createNode('param', 10, 0, {
    scope: 'signal',
    param: 'velocity',
    mode: 'sequence',
    values: '20 110',
  }));
  const note = addNode(p, createNode('note', 20, 0, { velocity: 0 }));
  connect(p, clock.id, mod.id);
  connect(p, mod.id, note.id);
  const { notes } = run(p, 1.1 + walk(p, clock, mod, note));
  assert.deepEqual(notes.slice(0, 2).map((n) => n.vel), [20, 110]);
});

test('ratchet subdivides one trigger', () => {
  const { p, clock, note } = basicPatch({}, { ratchet: 4, length: 1 });
  const { notes } = run(p, 0.6 + walk(p, clock, note));
  const hits = notes.slice(0, 4).map((n) => n.at);
  assert.equal(hits.length, 4);
  assert.ok(Math.abs(hits[1] - hits[0] - 0.125) < 1e-6);
});

test('a synth node renders audio and sends no MIDI', () => {
  const p = createPatch('t');
  p.bpm = 120;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const voice = addNode(p, createNode('synth', 10, 0));
  connect(p, clock.id, voice.id);
  const { notes, audio } = run(p, 1.1 + walk(p, clock, voice));
  assert.equal(notes.length, 0);
  assert.ok(audio.voices.length >= 2);
});

test('feedback loops terminate', () => {
  const p = createPatch('t');
  p.bpm = 120;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const a = addNode(p, createNode('note', 10, 0, { midiOn: true, audition: false }));
  const b = addNode(p, createNode('note', 20, 0, { midiOn: true, audition: false }));
  connect(p, clock.id, a.id);
  connect(p, a.id, b.id);
  connect(p, b.id, a.id); // a loop with no delay
  const { notes } = run(p, 1.1);
  assert.ok(notes.length > 0);
  assert.ok(notes.length < 300, `hop limit should cap the loop, got ${notes.length}`);
});

test('polyrhythm ratio changes the step length', () => {
  const { p } = basicPatch({ division: '1/4', ratioNum: 3, ratioDen: 2 });
  const { notes } = run(p, 2);
  // 3 steps in the space of 2 quarter notes -> 1/3 of a second each.
  assert.ok(Math.abs(notes[1].at - notes[0].at - 1 / 3) < 1e-6);
});

test('key-step and value parsing survive junk', () => {
  assert.deepEqual(parseKeySteps('0:major 7:minor'), [
    { root: 0, scale: 'major' },
    { root: 7, scale: 'minor' },
  ]);
  assert.deepEqual(parseKeySteps(''), [{ root: 0, scale: 'minPent' }]);
  assert.deepEqual(parseKeySteps('99:nope'), [{ root: 11, scale: 'minPent' }]);
  assert.deepEqual(parseValues('1 2  3'), [1, 2, 3]);
  assert.deepEqual(parseValues('junk'), [0]);
});

/* ------------------------------------------------ distance as musical time */

test('moving a node retimes the patch', () => {
  const { p, clock, note } = basicPatch();
  const near = run(p, 2 + walk(p, clock, note)).notes[0].at;
  const wasAt = walk(p, clock, note);

  note.col += 8; // two more bars of line at the default grid
  const far = run(p, 2 + walk(p, clock, note)).notes[0].at;

  assert.ok(far > near, `${far} should be later than ${near}`);
  assert.ok(
    Math.abs(far - near - (walk(p, clock, note) - wasAt)) < 1e-6,
    'and later by exactly what the extra line is worth',
  );
});

test('the grid decides what a cell of line costs', () => {
  const { p, clock, note } = basicPatch();
  const eighths = run(p, 2 + walk(p, clock, note)).notes[0].at;

  p.grid = '1/16';
  const sixteenths = run(p, 2 + walk(p, clock, note)).notes[0].at;

  // Half the note value, half the travel. The 0.08s anchor is not travel, so
  // it is taken off both sides before they are compared.
  assert.ok(Math.abs((eighths - 0.08) / 2 - (sixteenths - 0.08)) < 1e-6);
});

test('a line with no length costs no time', () => {
  const { p, clock, note, line } = basicPatch();
  const lat = walk(p, clock, note);
  p.grid = '1/32';
  assert.ok(walk(p, clock, note) < lat, 'the finest grid is the cheapest');
  line.delay = 0;
  const { notes } = run(p, 2 + lat);
  assert.ok(Math.abs(notes[0].at - (0.08 + walk(p, clock, note))) < 1e-6);
});

test('the measurement is not cached across a move', () => {
  const { p, clock, note } = basicPatch();
  const audio = fakeAudio();
  const engine = new Engine({ getPatch: () => p, audio, midi: fakeMidi() });
  const line = p.lines[0];
  const before = engine.travelBeats(p, line);
  note.col += 10;
  assert.ok(engine.travelBeats(p, line) > before, 'a moved node is measured again');
  const held = engine.travelBeats(p, line);
  assert.equal(engine.travelBeats(p, line), held, 'and a still one is not');
});

test('a line that goes nowhere costs nothing rather than throwing', () => {
  const { p } = basicPatch();
  const engine = new Engine({ getPatch: () => p, audio: fakeAudio(), midi: fakeMidi() });
  assert.equal(engine.travelBeats(p, { id: 'x', from: 'nope', to: 'also nope' }), 0);
});
