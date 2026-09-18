// Control change output from Param nodes.
//
// A Param node could only ever move something inside the app. This is the path
// that lets it move something on the instrument being driven.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { createPatch, createNode, addNode, connect, createChannel } from '../src/model.js';
import { fakeMidi, fakeAudio, wiredMidi } from './helpers.js';
import { LIMITS } from '../src/limits.js';
import { lineCells } from '../src/geometry.js';
import { gridBeats } from '../src/rhythm.js';

/** Seconds a pulse spends walking a chain: distance on the grid is time. */
function walk(p, ...nodes) {
  let beats = 0;
  for (let i = 1; i < nodes.length; i += 1) {
    beats += lineCells(nodes[i - 1], nodes[i]) * gridBeats(p.grid);
  }
  return (beats * 60) / p.bpm;
}

function run(patch, seconds, { step = 0.02 } = {}) {
  const audio = fakeAudio();
  const midi = fakeMidi();
  const fires = [];
  const engine = new Engine({ getPatch: () => patch, audio, midi, onFire: (f) => fires.push(f) });
  engine.start();
  for (let t = 0; t < seconds; t += step) {
    audio.t = t;
    engine.tick();
  }
  return {
    midi,
    fires,
    controls: midi.controls.filter((c) => c.at < seconds),
    notes: midi.notes.filter((n) => n.at < seconds),
  };
}

/** clock -> param(CC) -> note, which is the ordinary way it gets used. */
function ccPatch(paramOverrides = {}, lineSetup) {
  const p = createPatch('cc');
  p.bpm = 120;
  p.scale = 'major';
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const mod = addNode(p, createNode('param', 10, 0, {
    scope: 'midi',
    cc: 74,
    mode: 'sequence',
    values: '0 64 127',
    ...paramOverrides,
  }));
  const note = addNode(p, createNode('note', 20, 0, { audition: false }));
  const line = connect(p, clock.id, mod.id);
  connect(p, mod.id, note.id);
  if (lineSetup) lineSetup(line);
  return { p, clock, mod, note, line };
}

test('a Param node in CC scope sends control changes', () => {
  const { p, clock, mod } = ccPatch();
  const { controls } = run(p, 2 + walk(p, clock, mod));
  assert.ok(controls.length >= 3, `sent ${controls.length}`);
  assert.deepEqual(controls.slice(0, 3).map((c) => c.value), [0, 64, 127]);
  assert.ok(controls.every((c) => c.cc === 74));
});

test('the line decides where a CC goes, as it does for notes', () => {
  const { p, clock, mod } = ccPatch({}, (line) => {
    line.channelMode = 'set';
    line.channels = [createChannel(3, 'A'), createChannel(9, 'B')];
  });
  const { controls } = run(p, 1 + walk(p, clock, mod));
  const first = controls.filter((c) => c.at === controls[0].at);
  assert.deepEqual(
    first.map((c) => `${c.slot}:${c.ch}`),
    ['A:3', 'B:9'],
    'one controller reaches both instruments the line feeds',
  );
});

test('a CC node still passes the pulse on', () => {
  const { p, clock, mod, note } = ccPatch();
  // The CC leaves the Param; the note is a line further on. Count over a span
  // that covers both, then compare like for like.
  const { notes, controls } = run(p, 2 + walk(p, clock, mod, note));
  assert.ok(notes.length >= 3, 'the note after it still plays');
  const sameSpan = controls.filter((c) => c.at < 2 + walk(p, clock, mod));
  const played = notes.filter((n) => n.at < 2 + walk(p, clock, mod, note));
  assert.equal(played.length, sameSpan.length, 'one of each per pulse');
});

test('values are held to seven bits whatever the node says', () => {
  const { p, clock, mod } = ccPatch({ mode: 'sequence', values: '-40 200 63.7' });
  const { controls } = run(p, 2 + walk(p, clock, mod));
  assert.deepEqual(controls.slice(0, 3).map((c) => c.value), [0, 127, 64]);
});

test('random and walk stay inside the range asked for', () => {
  for (const mode of ['random', 'walk']) {
    const { p, clock, mod } = ccPatch({ mode, min: 20, max: 40, amount: 5 });
    const { controls } = run(p, 4 + walk(p, clock, mod));
    assert.ok(controls.length > 3, mode);
    for (const c of controls) {
      assert.ok(c.value >= 20 && c.value <= 40, `${mode} produced ${c.value}`);
    }
  }
});

test('a range wider than MIDI allows is clamped, not wrapped', () => {
  const { p } = ccPatch({ mode: 'random', min: -500, max: 9000 });
  const { controls } = run(p, 3);
  for (const c of controls) assert.ok(c.value >= 0 && c.value <= 127, `${c.value}`);
});

test('the controller number is reported for the inspector', () => {
  const { p, clock, mod } = ccPatch({ cc: 1 });
  const { fires } = run(p, 1 + walk(p, clock, mod));
  const cc = fires.find((f) => f.kind === 'cc');
  assert.ok(cc);
  assert.equal(cc.nodeId, mod.id);
  assert.equal(cc.cc, 1);
  assert.ok(Array.isArray(cc.sent));
});

test('node and signal scopes are untouched by any of this', () => {
  const p = createPatch('other');
  p.bpm = 120;
  p.scale = 'major';
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const note = addNode(p, createNode('note', 20, 0, { degree: 1, octave: 4, audition: false }));
  const mod = addNode(p, createNode('param', 10, 0, {
    scope: 'node', target: note.id, param: 'degree', mode: 'sequence', values: '1 3 5',
  }));
  connect(p, clock.id, mod.id);
  connect(p, mod.id, note.id);
  const { notes, controls } = run(p, 2 + walk(p, clock, mod, note));
  assert.equal(controls.length, 0, 'nothing goes out on the wire');
  assert.ok(notes.length > 0, 'the note still plays');
  // Which degree lands when is a question about distance, and belongs to the
  // engine tests; here it only matters that nothing reached the wire.
  assert.ok(notes.every((n) => [60, 64, 67].includes(n.note)), 'degrees come from the sequence');
});

/* ------------------------------------------------- at the port itself */

test('a controller that has not moved is not sent again', async () => {
  const { midi, ports } = await wiredMidi();
  for (let i = 0; i < 10; i += 1) {
    midi.sendControl({ channel: 1, controller: 74, value: 100, at: 0 });
  }
  assert.equal(ports.A.sends.length, 1, 'CC is the usual reason a cable saturates');
  midi.sendControl({ channel: 1, controller: 74, value: 101, at: 0 });
  assert.equal(ports.A.sends.length, 2, 'a change does go out');
  midi.sendControl({ channel: 1, controller: 74, value: 100, at: 0 });
  assert.equal(ports.A.sends.length, 3, 'and so does going back');
});

test('the same controller on another channel or device is its own', async () => {
  const { midi, ports } = await wiredMidi({ slots: { A: 'iac', B: 'drums' } });
  midi.sendControl({ slot: 'A', channel: 1, controller: 74, value: 64, at: 0 });
  midi.sendControl({ slot: 'A', channel: 2, controller: 74, value: 64, at: 0 });
  midi.sendControl({ slot: 'B', channel: 1, controller: 74, value: 64, at: 0 });
  assert.equal(ports.A.sends.length, 2);
  assert.equal(ports.B.sends.length, 1);
});

test('the bytes are a control change on the right channel', async () => {
  const { midi, ports } = await wiredMidi();
  midi.sendControl({ channel: 5, controller: 74, value: 100, at: 0 });
  assert.deepEqual(ports.A.sends[0].data, [0xb4, 74, 100]);
});

test('channel, controller and value are clamped to legal MIDI', async () => {
  const { midi, ports } = await wiredMidi();
  midi.sendControl({ channel: 0, controller: -5, value: -20, at: 0 });
  midi.sendControl({ channel: 99, controller: 999, value: 999, at: 0 });
  assert.deepEqual(ports.A.sends.map((s) => s.data), [[0xb0, 0, 0], [0xbf, 127, 127]]);
  for (const send of ports.A.sends) {
    for (const byte of send.data) assert.ok(byte >= 0 && byte <= 255);
  }
});

test('a flood of controllers is throttled like notes', async () => {
  const { midi, ports } = await wiredMidi();
  let sent = 0;
  for (let i = 0; i < 5000; i += 1) {
    if (midi.sendControl({ channel: 1, controller: i % 100, value: i % 128, at: 0 })) sent += 1;
  }
  assert.ok(sent < 5000, 'the surplus was dropped');
  assert.ok(sent <= LIMITS.midiPerSecond, `${sent} messages in a second`);
});

test('panic forgets where the controllers were left', async () => {
  const { midi, ports } = await wiredMidi();
  midi.sendControl({ channel: 1, controller: 74, value: 64, at: 0 });
  midi.allOff();
  ports.A.sends.length = 0;
  midi.sendControl({ channel: 1, controller: 74, value: 64, at: 0 });
  assert.equal(ports.A.sends.length, 1, 'the device was reset, so say it again');
});

test('an unbound slot sends nothing and reports as much', async () => {
  const { midi, ports } = await wiredMidi({ slots: { A: 'iac' } });
  assert.equal(midi.sendControl({ slot: 'D', channel: 1, controller: 74, value: 64, at: 0 }), false);
  assert.equal(ports.A.sends.length, 0);
});
