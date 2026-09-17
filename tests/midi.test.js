// MIDI output: what actually reaches the port.
//
// This is the part of the app that matters most, since the point of Gridi is
// driving other instruments. A fake port records what it was handed, so the
// byte stream can be asserted on directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidiOut, SLOTS } from '../src/midi.js';
import { wiredMidi, stream } from './helpers.js';

async function rig() {
  const { midi, ports } = await wiredMidi();
  return { midi, port: ports.A };
}

/** Shorthand for the common single-output case. */
const play = (midi, channel, note, at, duration, velocity = 100, slot = 'A') =>
  midi.noteOn({ slot, channel, note, velocity, at, duration });

test('a note sends on now and off when flushed', async () => {
  const { midi, port } = await rig();
  play(midi, 1, 60, 0, 0.5, 100);
  assert.equal(port.sends.length, 1, 'the note-off is held back, not sent up front');
  midi.flush(0.5);
  const s = stream(port);
  assert.deepEqual(s.map((x) => [x.type, x.note]), [['on', 60], ['off', 60]]);
  assert.equal(s[0].vel, 100);
  assert.equal(s[0].ch, 1);
  assert.ok(Math.abs(s[1].at - 500) < 5, `off at ${s[1].at}ms`);
});

test('retriggering a held note releases it first', async () => {
  const { midi, port } = await rig();
  // One Note node, length four times its retrigger interval.
  play(midi, 1, 60, 0.0, 0.5, 100);
  play(midi, 1, 60, 0.25, 0.5, 100);
  play(midi, 1, 60, 0.5, 0.5, 100);
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

test('a note that ends before the next one starts is left alone', async () => {
  const { midi, port } = await rig();
  play(midi, 1, 60, 0, 0.2, 100);
  play(midi, 1, 60, 0.5, 0.2, 100);
  midi.flush(1);
  const s = stream(port);
  assert.ok(Math.abs(s[1].at - 200) < 5, 'the first release keeps its own time, not the retrigger gap');
  assert.deepEqual(s.map((x) => x.type), ['on', 'off', 'on', 'off']);
});

test('the same pitch on a different channel is a different note', async () => {
  const { midi, port } = await rig();
  play(midi, 1, 60, 0, 0.5, 100);
  play(midi, 2, 60, 0.25, 0.5, 100);
  midi.flush(1.2);
  const s = stream(port);
  assert.deepEqual(s.map((x) => [x.ch, x.type]), [[1, 'on'], [2, 'on'], [1, 'off'], [2, 'off']]);
  assert.ok(Math.abs(s[2].at - 500) < 5, 'channel 1 keeps its full length');
});

test('different pitches on one channel do not disturb each other', async () => {
  const { midi, port } = await rig();
  play(midi, 1, 60, 0, 0.5, 100);
  play(midi, 1, 64, 0.25, 0.5, 100);
  midi.flush(1.2);
  const s = stream(port);
  assert.deepEqual(s.map((x) => [x.note, x.type]), [[60, 'on'], [64, 'on'], [60, 'off'], [64, 'off']]);
});

test('a chord across channels from one pulse stays together', async () => {
  const { midi, port } = await rig();
  for (const ch of [1, 5, 11]) play(midi, ch, 60, 0, 0.25, 90);
  midi.flush(0.5);
  const ons = stream(port).filter((x) => x.type === 'on');
  assert.deepEqual(ons.map((x) => x.ch), [1, 5, 11]);
  assert.ok(ons.every((x) => x.at === ons[0].at), 'all at the same instant');
});

test('note-offs are held until they are nearly due', async () => {
  const { midi, port } = await rig();
  play(midi, 1, 60, 0, 4, 100);
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

test('channel, note and velocity are clamped to legal MIDI', async () => {
  const { midi, port } = await rig();
  play(midi, 0, -5, 0, 0.1, 0);
  play(midi, 99, 300, 0, 0.1, 999);
  const s = stream(port);
  assert.deepEqual(s.map((x) => [x.ch, x.note, x.vel]), [[1, 0, 1], [16, 127, 127]]);
  for (const send of port.sends) {
    for (const byte of send.data) assert.ok(byte >= 0 && byte <= 255, 'bytes stay in range');
  }
});

test('panic releases what is sounding and silences every channel', async () => {
  const { midi, port } = await rig();
  play(midi, 1, 60, 0, 4, 100);
  play(midi, 3, 67, 0, 4, 100);
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

test('with no output bound nothing is sent and nothing throws', async () => {
  const { midi, port } = await rig();
  midi.bind('A', null);
  port.sends.length = 0;
  assert.doesNotThrow(() => {
    play(midi, 1, 60, 0, 0.5, 100);
    midi.flush(1);
    midi.allOff();
  });
  assert.equal(port.sends.length, 0);
});

test('a port that fails mid-send does not take the scheduler down', async () => {
  const { midi, port } = await rig();
  port.send = () => { throw new Error('port closed'); };
  assert.doesNotThrow(() => {
    play(midi, 1, 60, 0, 0.5, 100);
    midi.flush(1);
  });
});

test('rebinding a slot releases what the old device was holding', async () => {
  const { midi, port } = await rig();
  play(midi, 1, 60, 0, 4, 100);
  port.sends.length = 0;
  midi.bind('A', null);
  assert.ok(port.sends.some((s) => (s.data[0] & 0xf0) === 0x80), 'the old device is told to stop');
  assert.equal(midi.sounding.size, 0);
});

/* ------------------------------------------------------- several outputs */

test('one line can drive two devices at once', async () => {
  const { midi, ports } = await wiredMidi({ slots: { A: 'iac', B: 'drums' } });
  midi.noteOn({ slot: 'A', channel: 1, note: 60, velocity: 100, at: 0, duration: 0.25 });
  midi.noteOn({ slot: 'B', channel: 10, note: 36, velocity: 120, at: 0, duration: 0.25 });
  midi.flush(1);

  assert.deepEqual(stream(ports.A).map((x) => [x.type, x.ch, x.note]), [['on', 1, 60], ['off', 1, 60]]);
  assert.deepEqual(stream(ports.B).map((x) => [x.type, x.ch, x.note]), [['on', 10, 36], ['off', 10, 36]]);
});

test('the same pitch and channel on two devices are two separate notes', async () => {
  const { midi, ports } = await wiredMidi({ slots: { A: 'iac', B: 'drums' } });
  midi.noteOn({ slot: 'A', channel: 1, note: 60, velocity: 100, at: 0, duration: 0.5 });
  midi.noteOn({ slot: 'B', channel: 1, note: 60, velocity: 100, at: 0.25, duration: 0.5 });
  midi.flush(2);
  // Neither should have been cut short by the other's retrigger handling.
  assert.equal(stream(ports.A).filter((x) => x.type === 'off').length, 1);
  assert.equal(stream(ports.B).filter((x) => x.type === 'off').length, 1);
  const offA = stream(ports.A).find((x) => x.type === 'off');
  assert.ok(Math.abs(offA.at - 500) < 5, 'A keeps its full length');
});

test('an unbound slot silently drops its notes rather than throwing', async () => {
  const { midi, ports } = await wiredMidi({ slots: { A: 'iac' } });
  assert.doesNotThrow(() => {
    midi.noteOn({ slot: 'C', channel: 1, note: 60, velocity: 100, at: 0, duration: 0.25 });
  });
  assert.equal(ports.A.sends.length, 0, 'and does not leak onto another device');
});

test('an unknown slot name falls back to the first output', async () => {
  const { midi, ports } = await wiredMidi({ slots: { A: 'iac' } });
  midi.noteOn({ slot: 'Z', channel: 1, note: 60, velocity: 100, at: 0, duration: 0.25 });
  assert.equal(stream(ports.A).length, 1);
});

test('panic silences every bound device', async () => {
  const { midi, ports } = await wiredMidi({ slots: { A: 'iac', B: 'drums' } });
  midi.noteOn({ slot: 'A', channel: 1, note: 60, velocity: 100, at: 0, duration: 4 });
  midi.noteOn({ slot: 'B', channel: 10, note: 36, velocity: 100, at: 0, duration: 4 });
  ports.A.sends.length = 0;
  ports.B.sends.length = 0;
  midi.allOff();
  for (const [name, port] of Object.entries(ports)) {
    assert.equal(port.cleared, 1, `${name} cancelled its queue`);
    const allNotesOff = port.sends.filter((s) => (s.data[0] & 0xf0) === 0xb0 && s.data[1] === 123);
    assert.equal(allNotesOff.length, 16, `${name} silenced every channel`);
  }
  assert.equal(midi.sounding.size, 0);
});

test('each device gets its own throttle budget', async () => {
  const { midi, ports } = await wiredMidi({ slots: { A: 'iac', B: 'drums' } });
  for (let i = 0; i < 4000; i += 1) {
    midi.noteOn({ slot: 'A', channel: 1, note: 20 + (i % 100), velocity: 100, at: 0, duration: 0.1 });
  }
  // A is swamped; B has sent nothing and must still be free to play.
  midi.noteOn({ slot: 'B', channel: 1, note: 60, velocity: 100, at: 0, duration: 0.1 });
  assert.equal(ports.B.sends.length, 1, 'one busy device does not gag the others');
});

test('slots are a fixed, ordered set', () => {
  assert.deepEqual(SLOTS, ['A', 'B', 'C', 'D']);
});
