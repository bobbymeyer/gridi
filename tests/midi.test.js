// MIDI output: what actually reaches the port.
//
// This is the part of the app that matters most, since the point of Gridi is
// driving other instruments. A fake port records what it was handed, so the
// byte stream can be asserted on directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidiOut } from '../src/midi.js';

function rig() {
  const port = {
    sends: [],
    cleared: 0,
    send(data, ts) { this.sends.push({ data: [...data], ts: ts ?? 0 }); },
    clear() { this.cleared += 1; },
  };
  const clock = { t: 0, now() { return this.t; } };
  const midi = new MidiOut(clock);
  midi.access = { outputs: new Map([['p', port]]) };
  midi.outputId = 'p';
  return { midi, port, clock };
}

/** What the device sees, in delivery order: [type, note, ms since first]. */
function stream(port) {
  if (!port.sends.length) return [];
  const base = Math.min(...port.sends.map((s) => s.ts));
  return port.sends
    .map((s) => {
      const status = s.data[0] & 0xf0;
      const type = status === 0x90 ? 'on' : status === 0x80 ? 'off' : 'cc';
      return { type, ch: (s.data[0] & 0x0f) + 1, note: s.data[1], vel: s.data[2], at: Math.round(s.ts - base) };
    })
    .sort((a, b) => a.at - b.at);
}

test('a note sends on now and off when flushed', () => {
  const { midi, port } = rig();
  midi.noteOn(1, 60, 100, 0, 0.5);
  assert.equal(port.sends.length, 1, 'the note-off is held back, not sent up front');
  midi.flush(0.5);
  const s = stream(port);
  assert.deepEqual(s.map((x) => [x.type, x.note]), [['on', 60], ['off', 60]]);
  assert.equal(s[0].vel, 100);
  assert.equal(s[0].ch, 1);
  assert.ok(Math.abs(s[1].at - 500) < 5, `off at ${s[1].at}ms`);
});

test('retriggering a held note releases it first', () => {
  const { midi, port } = rig();
  // One Note node, length four times its retrigger interval.
  midi.noteOn(1, 60, 100, 0.0, 0.5);
  midi.noteOn(1, 60, 100, 0.25, 0.5);
  midi.noteOn(1, 60, 100, 0.5, 0.5);
  midi.flush(1.2);

  const s = stream(port);
  assert.deepEqual(
    s.map((x) => x.type),
    ['on', 'off', 'on', 'off', 'on', 'off'],
    'every note is released before the next one starts',
  );
  // No note-off ever lands on top of the note that follows it.
  for (let i = 1; i < s.length; i += 1) assert.ok(s[i].at >= s[i - 1].at, 'ordered');
  assert.ok(s[1].at < s[2].at, 'release precedes retrigger');
  assert.ok(Math.abs(s[2].at - 250) < 5, 'the retrigger keeps its own timing');
  assert.equal(s.filter((x) => x.type === 'on').length, 3);
  assert.equal(s.filter((x) => x.type === 'off').length, 3, 'no stray or missing releases');
});

test('a note that ends before the next one starts is left alone', () => {
  const { midi, port } = rig();
  midi.noteOn(1, 60, 100, 0, 0.2);
  midi.noteOn(1, 60, 100, 0.5, 0.2);
  midi.flush(1);
  const s = stream(port);
  assert.ok(Math.abs(s[1].at - 200) < 5, 'the first release keeps its own time, not the retrigger gap');
  assert.deepEqual(s.map((x) => x.type), ['on', 'off', 'on', 'off']);
});

test('the same pitch on a different channel is a different note', () => {
  const { midi, port } = rig();
  midi.noteOn(1, 60, 100, 0, 0.5);
  midi.noteOn(2, 60, 100, 0.25, 0.5);
  midi.flush(1.2);
  const s = stream(port);
  assert.deepEqual(s.map((x) => [x.ch, x.type]), [[1, 'on'], [2, 'on'], [1, 'off'], [2, 'off']]);
  assert.ok(Math.abs(s[2].at - 500) < 5, 'channel 1 keeps its full length');
});

test('different pitches on one channel do not disturb each other', () => {
  const { midi, port } = rig();
  midi.noteOn(1, 60, 100, 0, 0.5);
  midi.noteOn(1, 64, 100, 0.25, 0.5);
  midi.flush(1.2);
  const s = stream(port);
  assert.deepEqual(s.map((x) => [x.note, x.type]), [[60, 'on'], [64, 'on'], [60, 'off'], [64, 'off']]);
});

test('a chord across channels from one pulse stays together', () => {
  const { midi, port } = rig();
  for (const ch of [1, 5, 11]) midi.noteOn(ch, 60, 90, 0, 0.25);
  midi.flush(0.5);
  const ons = stream(port).filter((x) => x.type === 'on');
  assert.deepEqual(ons.map((x) => x.ch), [1, 5, 11]);
  assert.ok(ons.every((x) => x.at === ons[0].at), 'all at the same instant');
});

test('note-offs are held until they are nearly due', () => {
  const { midi, port } = rig();
  midi.noteOn(1, 60, 100, 0, 4);
  midi.flush(0);
  assert.equal(port.sends.length, 1, 'still held');
  midi.flush(3.8);
  assert.equal(port.sends.length, 1, 'still held just outside the window');
  midi.flush(3.95);
  assert.equal(port.sends.length, 2, 'released once it comes inside the window');
  midi.flush(4.5);
  assert.equal(port.sends.length, 2, 'and only once');
  assert.equal(midi.pendingOffs.length, 0, 'and is no longer queued');
});

test('channel, note and velocity are clamped to legal MIDI', () => {
  const { midi, port } = rig();
  midi.noteOn(0, -5, 0, 0, 0.1);
  midi.noteOn(99, 300, 999, 0, 0.1);
  const s = stream(port);
  assert.deepEqual(s.map((x) => [x.ch, x.note, x.vel]), [[1, 0, 1], [16, 127, 127]]);
  for (const send of port.sends) {
    for (const byte of send.data) assert.ok(byte >= 0 && byte <= 255, 'bytes stay in range');
  }
});

test('panic releases what is sounding and silences every channel', () => {
  const { midi, port } = rig();
  midi.noteOn(1, 60, 100, 0, 4);
  midi.noteOn(3, 67, 100, 0, 4);
  port.sends.length = 0;
  midi.allOff();

  assert.equal(port.cleared, 1, 'pending messages are cancelled at the port');
  const offs = port.sends.filter((s) => (s.data[0] & 0xf0) === 0x80);
  assert.deepEqual(offs.map((s) => s.data[1]).sort((a, b) => a - b), [60, 67]);
  const allNotesOff = port.sends.filter((s) => (s.data[0] & 0xf0) === 0xb0 && s.data[1] === 123);
  assert.equal(allNotesOff.length, 16, 'every channel');
  assert.equal(midi.sounding.size, 0);
  assert.equal(midi.pendingOffs.length, 0);

  port.sends.length = 0;
  midi.flush(10);
  assert.equal(port.sends.length, 0, 'nothing left over after a panic');
});

test('with no output selected nothing is sent and nothing throws', () => {
  const { midi, port } = rig();
  midi.outputId = null;
  assert.doesNotThrow(() => {
    midi.noteOn(1, 60, 100, 0, 0.5);
    midi.flush(1);
    midi.allOff();
  });
  assert.equal(port.sends.length, 0);
});

test('a port that fails mid-send does not take the scheduler down', () => {
  const { midi, port } = rig();
  port.send = () => { throw new Error('port closed'); };
  assert.doesNotThrow(() => {
    midi.noteOn(1, 60, 100, 0, 0.5);
    midi.flush(1);
  });
});

test('switching port releases what the old one was holding', () => {
  const { midi, port } = rig();
  midi.noteOn(1, 60, 100, 0, 4);
  port.sends.length = 0;
  midi.setOutput('other');
  assert.ok(port.sends.some((s) => (s.data[0] & 0xf0) === 0x80), 'the old port is told to stop');
  assert.equal(midi.sounding.size, 0);
});
