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
  // Four cells of line between the two, a sixteenth note each: one beat.
  const lat = walk(p, clock, note);
  assert.ok(Math.abs(lat - 0.5) < 1e-9, `four cells at 1/16 is a beat, got ${lat}s`);
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
  const cycle = [60, 64, 67];
  const settled = notes.filter((n) => n.at > 4).slice(0, 6).map((n) => n.note);
  assert.equal(settled.length, 6, 'enough notes to see the cycle');
  const from = cycle.indexOf(settled[0]);
  assert.ok(from >= 0, `${settled[0]} is not one of the three`);
  assert.deepEqual(
    settled,
    settled.map((_, i) => cycle[(from + i) % cycle.length]),
    'the three degrees come round in order, at whatever phase the distance sets',
  );
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
  const asDrawn = run(p, 2 + walk(p, clock, note)).notes[0].at;

  p.grid = '1/32';
  const thirtyseconds = run(p, 2 + walk(p, clock, note)).notes[0].at;

  // Half the note value, half the travel. The 0.08s anchor is not travel, so
  // it is taken off both sides before they are compared.
  assert.ok(Math.abs((asDrawn - 0.08) / 2 - (thirtyseconds - 0.08)) < 1e-6);
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

/* --------------------------------------------- a latched key, heard in time */

test('a latched key is read when the note sounds, not when the pulse left', () => {
  const p = createPatch('modulating');
  p.bpm = 120;
  p.grid = '1/16';
  p.scale = 'major';
  p.root = 0;

  // The key turns twice a second. The note is three seconds of line from its
  // clock, so its pulse is always in the air across several key changes.
  const keyClock = addNode(p, createNode('pulse', 0, 20, { division: '1/2' }));
  const key = addNode(p, createNode('key', 10, 20, {
    mode: 'cycle',
    steps: '0:major 7:major',
    latch: true,
  }));
  connect(p, keyClock.id, key.id);

  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/2' }));
  const note = addNode(p, createNode('note', 31, 0, { degree: 1, octave: 4, audition: false }));
  connect(p, clock.id, note.id);
  const lag = walk(p, clock, note);
  assert.ok(lag > 1, `the note wants to be several key changes away, is ${lag}s`);

  const audio = fakeAudio();
  const midi = fakeMidi();
  const keys = [];
  const engine = new Engine({
    getPatch: () => p,
    audio,
    midi,
    onFire: (f) => { if (f.kind === 'key') keys.push(f); },
  });
  engine.start();
  for (let t = 0; t < 5 + lag; t += 0.01) {
    audio.t = t;
    engine.tick();
  }

  // Whatever key was last set before a note sounded is the key that note is in.
  // Which pulse carried it, and how long ago that pulse left, does not come
  // into it.
  const notes = midi.notes.filter((n) => n.at > lag);
  assert.ok(notes.length >= 4, `only ${notes.length} notes to look at`);
  let checked = 0;
  for (const hit of notes) {
    const inForce = keys.filter((k) => k.time < hit.at - 1e-3).pop();
    if (!inForce) continue; // nothing had been set yet
    assert.equal(hit.note, inForce.root + 60, `at ${hit.at.toFixed(3)}s the key was ${inForce.root}`);
    checked += 1;
  }
  assert.ok(checked >= 4, `only ${checked} notes had a key to check against`);
  assert.ok(new Set(notes.map((n) => n.note)).size > 1, 'and the key really did move under them');
});

test('a key set on the line still beats the project, however late the pulse is', () => {
  const { p, clock, note, line } = basicPatch();
  p.scale = 'major';
  p.root = 0;
  note.params.degree = 1;
  line.scaleMode = 'set';
  line.scale = 'major';
  line.root = 5; // F, whatever the project does afterwards

  const { notes } = run(p, 2 + walk(p, clock, note));
  assert.ok(notes.length > 0);
  for (const hit of notes) assert.equal(hit.note, 65, 'F4, from the line');
});

/* ------------------------------------------------------------------ portal */

/**
 * A clock, a portal to fall into, a portal to come out of, and a note on the
 * far side of the second one. `gap` is how far the exit's note is drawn.
 */
function portalPatch({ letter = 'A', exitLetter = letter, gap = 10 } = {}) {
  const p = createPatch('portal');
  p.bpm = 120;
  p.grid = '1/16';
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4', velocity: 100 }));
  const into = addNode(p, createNode('portal', 10, 0, { pair: letter }));
  const outOf = addNode(p, createNode('portal', 0, 20, { pair: exitLetter }));
  const note = addNode(p, createNode('note', gap, 20, { degree: 1, octave: 4 }));
  connect(p, clock.id, into.id);
  connect(p, outOf.id, note.id, { channelMode: 'set', channels: [createChannel(1, 'A')] });
  return { p, clock, into, outOf, note };
}

test('a portal puts the pulse out of its other end on the same beat', () => {
  // The claim is that the hole is free, so the test is a race: eight cells of
  // line against four cells, a portal, and four more. If the hole costs
  // anything at all the two streams come apart.
  const direct = createPatch('direct');
  direct.bpm = 120;
  direct.grid = '1/16';
  const dClock = addNode(direct, createNode('pulse', 0, 0, { division: '1/4', velocity: 100 }));
  const dNote = addNode(direct, createNode('note', 14, 0, { degree: 1, octave: 4 }));
  connect(direct, dClock.id, dNote.id, { channelMode: 'set', channels: [createChannel(1, 'A')] });
  assert.equal(lineCells(dClock, dNote), 8, 'eight cells the long way round');

  const { p, clock, into, outOf, note } = portalPatch();
  assert.equal(lineCells(clock, into) + lineCells(outOf, note), 8, 'and eight through the hole');

  const through = run(p, 4).notes;
  const around = run(direct, 4).notes;
  assert.ok(through.length >= 4, 'the far side of the hole is playing');
  assert.deepEqual(
    through.map((n) => n.at.toFixed(6)),
    around.map((n) => n.at.toFixed(6)),
    'the hole took time',
  );
  // And it is still a clock: a quarter note at 120 is half a second.
  assert.ok(Math.abs((through[1].at - through[0].at) - 0.5) < 1e-9);
});

test('a portal with nobody on its letter is a dead end', () => {
  const { p } = portalPatch({ letter: 'A', exitLetter: 'B' });
  const { notes } = run(p, 4);
  assert.equal(notes.length, 0, 'the pulse went into the hole and stayed there');
});

test('one portal in is every other portal on the letter out', () => {
  const p = createPatch('portal');
  p.bpm = 120;
  p.grid = '1/16';
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const into = addNode(p, createNode('portal', 10, 0, { pair: 'A' }));
  connect(p, clock.id, into.id);
  // Two exits on the same letter, each with its own note, drawn the same
  // distance away so they should sound together.
  for (const row of [20, 30]) {
    const exit = addNode(p, createNode('portal', 0, row, { pair: 'a' })); // case is nothing
    const note = addNode(p, createNode('note', 10, row, { degree: 1, octave: 4 }));
    connect(p, exit.id, note.id, { channelMode: 'set', channels: [createChannel(1, 'A')] });
  }
  const { notes } = run(p, 2.2);
  assert.ok(notes.length >= 4 && notes.length % 2 === 0, 'both exits, every beat');
  assert.equal(notes[0].at, notes[1].at, 'and both ends spoke at once');
  assert.equal(notes[2].at, notes[3].at);
});

test('nothing comes back out of the portal it went into', () => {
  // A line out of the entrance is an ordinary line and is left alone; what the
  // portal must not do is hand the pulse back to itself and play it twice.
  const p = createPatch('portal');
  p.bpm = 120;
  p.grid = '1/16';
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const into = addNode(p, createNode('portal', 10, 0, { pair: 'A' }));
  const outOf = addNode(p, createNode('portal', 0, 20, { pair: 'A' }));
  const near = addNode(p, createNode('note', 20, 0, { degree: 1, octave: 4 }));
  const far = addNode(p, createNode('note', 10, 20, { degree: 1, octave: 4 }));
  connect(p, clock.id, into.id);
  connect(p, into.id, near.id, { channelMode: 'set', channels: [createChannel(1, 'A')] });
  connect(p, outOf.id, far.id, { channelMode: 'set', channels: [createChannel(2, 'A')] });
  const { notes } = run(p, 2.2);
  assert.equal(notes.filter((n) => n.ch === 1).length, 0,
    'the entrance swallowed the pulse rather than sending it on as well');
  assert.ok(notes.filter((n) => n.ch === 2).length >= 2, 'the far side played it');
});

test('a portal carries what the pulse was carrying', () => {
  const { p, outOf, note } = portalPatch();
  // The line into the exit's note says channel 7; the line into the portal
  // says channel 3. What comes out of the hole still answers to the chain it
  // fell into.
  p.lines[0].channelMode = 'set';
  p.lines[0].channels = [createChannel(3, 'A')];
  p.lines[1].channelMode = 'keep';
  const { notes } = run(p, 2.2);
  assert.ok(notes.length, 'something played');
  assert.equal(notes[0].ch, 3, 'the channel came through the hole');
  assert.equal(notes[0].vel, 100, 'and so did the velocity');
  assert.ok(outOf && note);
});

test('a ring of portals ends rather than spinning inside one tick', () => {
  // Two holes wired into each other: A comes out at B's entrance, B comes out
  // at A's. Every hop costs a line, so it is ordinary feedback -- but if the
  // hole itself were free in hops it would never stop.
  const p = createPatch('portal');
  p.bpm = 120;
  p.grid = '1/16';
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/1' }));
  const inA = addNode(p, createNode('portal', 10, 0, { pair: 'A' }));
  const outA = addNode(p, createNode('portal', 0, 20, { pair: 'A' }));
  const inB = addNode(p, createNode('portal', 10, 20, { pair: 'B' }));
  const outB = addNode(p, createNode('portal', 0, 40, { pair: 'B' }));
  connect(p, clock.id, inA.id);
  connect(p, outA.id, inB.id);
  connect(p, outB.id, inA.id);
  const started = Date.now();
  const { engine } = run(p, 2);
  assert.ok(Date.now() - started < 5000, 'it came back');
  assert.ok(engine.queue.size < 2000, 'and did not leave the queue full');
});
