// The guard rails, and the runaway they exist to catch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, SCOPE_NOTE, GUARDS, RateMeter, Governor } from '../src/limits.js';
import { Engine } from '../src/engine.js';
import { MidiOut } from '../src/midi.js';
import { createPatch, createNode, addNode, connect, deserialize } from '../src/model.js';
import { fakeMidi, fakeAudio, wiredMidi } from './helpers.js';

/* ------------------------------------------------------------- rate meter */

test('the meter reports events per second', () => {
  const meter = new RateMeter();
  for (let t = 0; t < 1; t += 0.01) meter.add(t, 10);
  assert.equal(meter.rate(0.99), 1000);
});

test('the meter forgets what has fallen out of the window', () => {
  const meter = new RateMeter();
  meter.add(0, 500);
  assert.equal(meter.rate(0.5), 500);
  assert.equal(meter.rate(5), 0, 'long past');
});

test('resetting the meter empties it', () => {
  const meter = new RateMeter();
  meter.add(0, 900);
  meter.reset();
  assert.equal(meter.rate(0), 0);
});

/* --------------------------------------------------------------- governor */

test('a governor reports once, not thousands of times', () => {
  const seen = [];
  const g = new Governor((t) => seen.push(t), { quietFor: 4 });
  for (let i = 0; i < 500; i += 1) g.trip('events', 0.001 * i);
  assert.equal(seen.length, 1, 'a runaway trips constantly; say so once');
});

test('it speaks up again once the quiet period has passed', () => {
  const seen = [];
  const g = new Governor((t) => seen.push(t), { quietFor: 4 });
  g.trip('events', 0);
  g.trip('events', 3.9);
  g.trip('events', 4.1);
  assert.equal(seen.length, 2);
});

test('different limits are reported separately', () => {
  const seen = [];
  const g = new Governor((t) => seen.push(t.kind), { quietFor: 4 });
  g.trip('events', 0);
  g.trip('midi', 0);
  g.trip('voices', 0);
  assert.deepEqual(seen, ['events', 'midi', 'voices']);
});

test('a specific note survives alongside the standing wording', () => {
  let got = null;
  const g = new Governor((t) => { got = t; });
  g.trip('events', 0, '412 pulses dropped');
  assert.equal(got.title, GUARDS.events.title);
  assert.equal(got.detail, GUARDS.events.detail, 'the general explanation');
  assert.equal(got.note, '412 pulses dropped', 'and what actually happened');
});

test('repeated trouble escalates, a one-off does not', () => {
  const g = new Governor(() => {});
  g.trip('events', 0);
  assert.ok(!g.shouldEscalate('events', 0));
  g.trip('events', 1);
  g.trip('events', 2);
  assert.ok(g.shouldEscalate('events', 2), 'three inside the window');
  assert.ok(!g.shouldEscalate('events', 60), 'but not forever afterwards');
});

test('resetting forgets everything', () => {
  const g = new Governor(() => {});
  for (let i = 0; i < 5; i += 1) g.trip('events', i * 0.1);
  g.reset();
  assert.ok(!g.shouldEscalate('events', 0.5));
});

test('every guard carries wording, and the scope note is about MIDI', () => {
  for (const [kind, guard] of Object.entries(GUARDS)) {
    assert.ok(guard.title.length > 0, kind);
    assert.ok(guard.detail.length > 20, kind);
  }
  assert.match(SCOPE_NOTE, /MIDI/);
  assert.match(SCOPE_NOTE, /not to be an audio engine/);
});

/* ------------------------------------------------------- engine, runaway */

function harness(patch) {
  const audio = fakeAudio();
  const midi = fakeMidi();
  const trips = [];
  const governor = new Governor((t) => trips.push(t));
  let stopped = false;
  const engine = new Engine({
    getPatch: () => patch,
    audio,
    midi,
    governor,
    onOverload: () => { stopped = true; },
  });
  return { engine, audio, midi, governor, trips, notes: () => midi.notes.length, stopped: () => stopped };
}

/** A splitter wired back into itself: one pulse becomes two, then four... */
function feedbackPatch(branches = 2) {
  const p = createPatch('runaway');
  p.bpm = 120;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const split = addNode(p, createNode('split', 5, 0));
  connect(p, clock.id, split.id);
  for (let i = 0; i < branches; i += 1) {
    const n = addNode(p, createNode('note', 10, i * 4, { audition: false }));
    connect(p, split.id, n.id);
    connect(p, n.id, split.id);
  }
  return p;
}

test('a runaway patch is cut off rather than run at the ceiling forever', () => {
  const patch = feedbackPatch();
  const rig = harness(patch);
  rig.engine.start();
  for (let i = 0; i < 60; i += 1) {
    rig.audio.t = i * 0.025;
    rig.engine.tick();
  }
  assert.ok(rig.trips.length > 0, 'the limit was reported');
  assert.equal(rig.trips[0].kind, 'events');
  assert.ok(rig.stopped(), 'and repeated trouble stopped the transport');
  // The clock keeps running in this harness, so the queue refills with ordinary
  // pending events; what matters is that it never grows without bound.
  assert.ok(rig.engine.queue.size < LIMITS.eventsPerTick, `queue held ${rig.engine.queue.size}`);
});

test('the per-tick ceiling holds whatever the patch does', () => {
  const patch = feedbackPatch(4);
  const rig = harness(patch);
  rig.engine.start();
  let worst = 0;
  for (let i = 0; i < 40; i += 1) {
    rig.audio.t = i * 0.025;
    const before = rig.notes();
    rig.engine.tick();
    worst = Math.max(worst, rig.notes() - before);
  }
  assert.ok(worst <= LIMITS.eventsPerTick, `one tick fired ${worst}`);
});

test('an ordinary patch never trips a guard', () => {
  const p = createPatch('ordinary');
  p.bpm = 174;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/32' }));
  const split = addNode(p, createNode('split', 5, 0));
  connect(p, clock.id, split.id);
  for (let i = 0; i < 6; i += 1) {
    const n = addNode(p, createNode('note', 10, i * 4, { audition: false }));
    connect(p, split.id, n.id);
  }
  const rig = harness(p);
  rig.engine.start();
  for (let i = 0; i < 400; i += 1) {
    rig.audio.t = i * 0.025; // ten seconds
    rig.engine.tick();
  }
  assert.deepEqual(rig.trips, [], 'a dense but sane patch is left alone');
  assert.ok(rig.notes() > 100, 'and it really was playing');
});

/* ----------------------------------------------------------- midi ceiling */

test('a MIDI flood is throttled, but never by dropping note-offs', async () => {
  const { midi, ports } = await wiredMidi();
  const port = ports.A;
  const trips = [];
  midi.governor = new Governor((t) => trips.push(t));

  for (let i = 0; i < 4000; i += 1) {
    midi.noteOn({ channel: 1 + (i % 16), note: 20 + (i % 100), velocity: 100, at: 0, duration: 0.1 });
  }

  const ons = port.sends.filter((s) => (s.data[0] & 0xf0) === 0x90).length;
  assert.ok(ons < 4000, 'the surplus was dropped');
  assert.ok(ons <= LIMITS.midiPerSecond, `${ons} note-ons in a second`);
  assert.ok(trips.some((t) => t.kind === 'midi'), 'and it was reported');

  // Everything accepted must still be released, or notes hang on the device.
  // Some releases go out during the loop, when a pitch is retriggered.
  midi.flush(10);
  const offs = port.sends.filter((s) => (s.data[0] & 0xf0) === 0x80).length;
  assert.equal(offs, ons, 'every note that sounded gets its release');
  assert.equal(midi.sounding.size, 0, 'nothing left hanging on the device');
  assert.equal(midi.pendingOffs.length, 0);
});

/* ------------------------------------------------------------ patch size */

test('an oversized patch is truncated rather than loaded whole', () => {
  const nodes = [];
  for (let i = 0; i < LIMITS.nodes + 50; i += 1) nodes.push({ type: 'note', col: i, row: 0, id: `n${i}` });
  const reported = [];
  const patch = deserialize(JSON.stringify({ nodes }), (kind, asked, kept) => reported.push({ kind, asked, kept }));
  assert.equal(patch.nodes.length, LIMITS.nodes);
  assert.deepEqual(reported, [{ kind: 'nodes', asked: LIMITS.nodes + 50, kept: LIMITS.nodes }]);
});

test('a patch inside the limits loads untouched and reports nothing', () => {
  const p = createPatch('small');
  addNode(p, createNode('pulse', 0, 0));
  const reported = [];
  const back = deserialize(JSON.stringify(p), (...args) => reported.push(args));
  assert.equal(back.nodes.length, 1);
  assert.deepEqual(reported, []);
});
