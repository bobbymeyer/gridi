import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, parseKeySteps, parseValues } from '../src/engine.js';
import { createPatch, createNode, addNode, connect, createChannel } from '../src/model.js';

/** Drives the engine with a fake clock so scheduling is deterministic. */
function run(patch, seconds, { step = 0.02 } = {}) {
  const audio = {
    t: 0,
    blips: [],
    voices: [],
    now() {
      return this.t;
    },
    blip(note, vel, at, dur) {
      this.blips.push({ note, vel, at, dur });
    },
    voice(params, note, vel, at, dur) {
      this.voices.push({ note, vel, at, dur });
    },
    allOff() {},
  };
  const notes = [];
  const midi = {
    noteOn(ch, note, vel, at, dur) {
      notes.push({ ch, note, vel, at, dur });
    },
    noteOff() {},
    allOff() {},
  };
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
    notes: notes.filter((n) => n.at < seconds),
    pulses: pulses.filter((p) => p.arriveTime < seconds),
    audio,
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
  const { p } = basicPatch();
  const { notes } = run(p, 2);
  // 120bpm, 1/4 notes -> every 0.5s, starting at the 0.08s anchor.
  assert.ok(notes.length >= 4, `got ${notes.length}`);
  assert.ok(Math.abs(notes[0].at - 0.08) < 1e-6);
  assert.ok(Math.abs(notes[1].at - notes[0].at - 0.5) < 1e-6);
  assert.equal(notes[0].note, 60); // C4
  assert.equal(notes[0].ch, 1);
});

test('tempo sets the interval', () => {
  const { p } = basicPatch();
  p.bpm = 60;
  const { notes } = run(p, 3);
  assert.ok(Math.abs(notes[1].at - notes[0].at - 1) < 1e-6);
});

test('an inactive emitter is silent', () => {
  const { p } = basicPatch({ running: false });
  assert.equal(run(p, 2).notes.length, 0);
});

test('swing pushes the off-beats late', () => {
  const { p } = basicPatch({ division: '1/8', swing: 0.4 });
  const { notes } = run(p, 1.2);
  const first = notes[1].at - notes[0].at;
  const second = notes[2].at - notes[1].at;
  assert.ok(first > second, 'long-short pairing expected');
});

test('euclid gating thins the clock out', () => {
  const { p } = basicPatch({ division: '1/4', euclidOn: true, euclidPulses: 2, euclidSteps: 4 });
  const { notes } = run(p, 4);
  // E(2,4) is x.x. -> half the quarter notes, across two bars.
  assert.equal(notes.length, 4);
});

test('a line carrying several channels fans one pulse across all of them', () => {
  const { p, line } = basicPatch();
  line.channelMode = 'set';
  line.channels = [createChannel(1), createChannel(5), createChannel(11)];
  const { notes } = run(p, 1.1);
  const firstHit = notes.filter((n) => Math.abs(n.at - notes[0].at) < 1e-9);
  assert.deepEqual(firstHit.map((n) => n.ch), [1, 5, 11]);
  assert.deepEqual(new Set(firstHit.map((n) => n.note)), new Set([60]));
});

test('per-channel transpose rides on the line', () => {
  const { p, line } = basicPatch();
  line.channelMode = 'set';
  line.channels = [createChannel(1), { ...createChannel(2), transpose: -12, velocity: 40 }];
  const { notes } = run(p, 0.6);
  assert.equal(notes[0].note, 60);
  assert.equal(notes[1].note, 48);
  assert.equal(notes[1].vel, 40);
});

test('a scale set on the line overrides the project key', () => {
  const { p, note, line } = basicPatch();
  p.scale = 'minPent';
  p.root = 9; // A minor pentatonic
  note.params.degree = 3;
  const projectAnswer = run(p, 0.6).notes[0].note;

  line.scaleMode = 'set';
  line.scale = 'major';
  line.root = 0;
  const lineAnswer = run(p, 0.6).notes[0].note;

  assert.equal(lineAnswer, 64); // E4, the 3rd of C major
  assert.notEqual(lineAnswer, projectAnswer);
});

test('line delay shifts arrival without moving the clock', () => {
  const { p, line } = basicPatch();
  line.delay = 0.5; // beats -> 0.25s at 120bpm
  const { notes } = run(p, 1.2);
  assert.ok(Math.abs(notes[0].at - (0.08 + 0.25)) < 1e-6);
  assert.ok(Math.abs(notes[1].at - notes[0].at - 0.5) < 1e-6, 'rate is unchanged');
});

test('a muted line stops passing pulses', () => {
  const { p, line } = basicPatch();
  line.muted = true;
  assert.equal(run(p, 2).notes.length, 0);
});

test('split sends to every branch at once', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const split = addNode(p, createNode('split', 5, 0));
  const a = addNode(p, createNode('note', 10, 0, { degree: 1, octave: 4 }));
  const b = addNode(p, createNode('note', 10, 5, { degree: 5, octave: 4 }));
  connect(p, clock.id, split.id);
  connect(p, split.id, a.id);
  connect(p, split.id, b.id);
  const { notes } = run(p, 1.1);
  const first = notes.filter((n) => Math.abs(n.at - notes[0].at) < 1e-9);
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((n) => n.note).sort((x, y) => x - y), [60, 67]);
});

test('split stagger flams the branches', () => {
  const p = createPatch('t');
  p.bpm = 120;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const split = addNode(p, createNode('split', 5, 0, { stagger: 0.25 }));
  const a = addNode(p, createNode('note', 10, 0));
  const b = addNode(p, createNode('note', 10, 5));
  connect(p, clock.id, split.id);
  connect(p, split.id, a.id);
  connect(p, split.id, b.id);
  const { notes } = run(p, 1.1);
  assert.ok(Math.abs(notes[1].at - notes[0].at - 0.125) < 1e-6);
});

test('router sends each pulse down exactly one line', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const router = addNode(p, createNode('router', 5, 0, { mode: 'cycle' }));
  const a = addNode(p, createNode('note', 10, 0, { degree: 1, octave: 4 }));
  const b = addNode(p, createNode('note', 10, 5, { degree: 2, octave: 4 }));
  const c = addNode(p, createNode('note', 10, 10, { degree: 3, octave: 4 }));
  connect(p, clock.id, router.id);
  connect(p, router.id, a.id);
  connect(p, router.id, b.id);
  connect(p, router.id, c.id);
  const { notes } = run(p, 2);
  assert.equal(notes.length, 4, 'one note per pulse, never two');
  assert.deepEqual(notes.map((n) => n.note), [60, 62, 64, 60]);
});

test('router ping-pong walks up and back', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const router = addNode(p, createNode('router', 5, 0, { mode: 'pingpong' }));
  for (const d of [1, 2, 3]) {
    const n = addNode(p, createNode('note', 10, d * 4, { degree: d, octave: 4 }));
    connect(p, router.id, n.id);
  }
  connect(p, clock.id, router.id);
  const { notes } = run(p, 3.1);
  assert.deepEqual(notes.slice(0, 5).map((n) => n.note), [60, 62, 64, 62, 60]);
});

test('probability gate at 0 and 100 is deterministic', () => {
  const build = (probability) => {
    const p = createPatch('t');
    p.bpm = 120;
    const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
    const chance = addNode(p, createNode('chance', 5, 0, { probability }));
    const note = addNode(p, createNode('note', 10, 0));
    connect(p, clock.id, chance.id);
    connect(p, chance.id, note.id);
    return p;
  };
  assert.equal(run(build(0), 2).notes.length, 0);
  assert.ok(run(build(100), 2).notes.length >= 4);
});

test('probability is reproducible for a given seed', () => {
  const build = (seed) => {
    const p = createPatch('t');
    p.bpm = 120;
    p.seed = seed;
    const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/16' }));
    const chance = addNode(p, createNode('chance', 5, 0, { probability: 50 }));
    const note = addNode(p, createNode('note', 10, 0));
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
  const slow = addNode(p, createNode('pulse', 0, 10, { division: '1/2' }));
  const gate = addNode(p, createNode('gate', 5, 5, { mode: 'all', windowMs: 20 }));
  const note = addNode(p, createNode('note', 10, 5));
  connect(p, fast.id, gate.id);
  connect(p, slow.id, gate.id);
  connect(p, gate.id, note.id);
  const { notes } = run(p, 4);
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
  const slow = addNode(p, createNode('pulse', 0, 10, { division: '1/2' }));
  const gate = addNode(p, createNode('gate', 5, 5, { mode: 'any' }));
  const note = addNode(p, createNode('note', 10, 5));
  connect(p, fast.id, gate.id);
  connect(p, slow.id, gate.id);
  connect(p, gate.id, note.id);
  const { notes } = run(p, 2);
  assert.equal(notes.length, 6); // 4 fast + 2 slow
});

test('XOR gate rejects coincidence', () => {
  const p = createPatch('t');
  p.bpm = 120;
  const fast = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const slow = addNode(p, createNode('pulse', 0, 10, { division: '1/2' }));
  const gate = addNode(p, createNode('gate', 5, 5, { mode: 'xor', windowMs: 20 }));
  const note = addNode(p, createNode('note', 10, 5));
  connect(p, fast.id, gate.id);
  connect(p, slow.id, gate.id);
  connect(p, gate.id, note.id);
  const { notes } = run(p, 4);
  assert.equal(notes.length, 4); // only the off-beats, where the slow clock is absent
});

test('a latching key node modulates the whole project live', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  p.root = 0;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const key = addNode(p, createNode('key', 5, 0, {
    mode: 'cycle',
    steps: '0:major 7:major',
    latch: true,
  }));
  const note = addNode(p, createNode('note', 10, 0, { degree: 1, octave: 4 }));
  connect(p, clock.id, key.id);
  connect(p, key.id, note.id);
  const { notes } = run(p, 2);
  assert.deepEqual(notes.slice(0, 4).map((n) => n.note), [60, 67, 60, 67]);
});

test('a latching key node rewrites the project key itself', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  p.root = 0;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const key = addNode(p, createNode('key', 5, 0, {
    mode: 'set',
    root: 5,
    scale: 'dorian',
    latch: true,
  }));
  connect(p, clock.id, key.id);
  run(p, 0.6);
  assert.equal(p.root, 5);
  assert.equal(p.scale, 'dorian');
});

test('a key change reaches only what is downstream of it', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  p.root = 0;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const split = addNode(p, createNode('split', 4, 0));
  const key = addNode(p, createNode('key', 8, 0, { mode: 'set', root: 5, scale: 'major' }));
  const shifted = addNode(p, createNode('note', 12, 0, { degree: 1, octave: 4 }));
  const untouched = addNode(p, createNode('note', 12, 8, { degree: 1, octave: 4 }));
  connect(p, clock.id, split.id);
  connect(p, split.id, key.id);
  connect(p, key.id, shifted.id);
  connect(p, split.id, untouched.id);
  const { notes } = run(p, 0.6);
  assert.deepEqual(new Set(notes.map((n) => n.note)), new Set([60, 65]));
});

test('a param node steps a target parameter', () => {
  const p = createPatch('t');
  p.bpm = 120;
  p.scale = 'major';
  p.root = 0;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const note = addNode(p, createNode('note', 10, 0, { degree: 1, octave: 4 }));
  const mod = addNode(p, createNode('param', 5, 0, {
    scope: 'node',
    target: note.id,
    param: 'degree',
    mode: 'sequence',
    values: '1 3 5',
  }));
  connect(p, clock.id, mod.id);
  connect(p, mod.id, note.id);
  const { notes } = run(p, 2);
  assert.deepEqual(notes.slice(0, 4).map((n) => n.note), [60, 64, 67, 60]);
});

test('a signal-scope param node rides with the pulse', () => {
  const p = createPatch('t');
  p.bpm = 120;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4', velocity: 100 }));
  const mod = addNode(p, createNode('param', 5, 0, {
    scope: 'signal',
    param: 'velocity',
    mode: 'sequence',
    values: '20 110',
  }));
  const note = addNode(p, createNode('note', 10, 0, { velocity: 0 }));
  connect(p, clock.id, mod.id);
  connect(p, mod.id, note.id);
  const { notes } = run(p, 1.1);
  assert.deepEqual(notes.slice(0, 2).map((n) => n.vel), [20, 110]);
});

test('ratchet subdivides one trigger', () => {
  const { p } = basicPatch({}, { ratchet: 4, length: 1 });
  const { notes } = run(p, 0.6);
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
  const { notes, audio } = run(p, 1.1);
  assert.equal(notes.length, 0);
  assert.ok(audio.voices.length >= 2);
});

test('feedback loops terminate', () => {
  const p = createPatch('t');
  p.bpm = 120;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const a = addNode(p, createNode('note', 5, 0, { midiOn: true, audition: false }));
  const b = addNode(p, createNode('note', 10, 0, { midiOn: true, audition: false }));
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
