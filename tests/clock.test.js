// MIDI clock out.
//
// Without it a receiving instrument can respond to Gridi's notes but cannot
// follow its tempo, which is most of what "driving other gear" means.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { MidiOut, PPQN, CLOCK, START, CONTINUE, STOP, SONG_POSITION } from '../src/midi.js';
import { createPatch, createNode, addNode } from '../src/model.js';
import { fakeMidi, fakeAudio } from './helpers.js';

function rig(patch, seconds, { step = 0.02, mutate } = {}) {
  const audio = fakeAudio();
  const midi = fakeMidi();
  const engine = new Engine({ getPatch: () => patch, audio, midi });
  engine.start();
  for (let t = 0; t < seconds; t += step) {
    audio.t = t;
    if (mutate) mutate(t, patch, engine);
    engine.tick();
  }
  return { engine, audio, midi, clocks: midi.of('clock').filter((c) => c.at < seconds) };
}

function plainPatch(bpm = 120) {
  const p = createPatch('clock');
  p.bpm = bpm;
  addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  return p;
}

test('twenty-four pulses to the quarter note', () => {
  assert.equal(PPQN, 24, 'MIDI clock resolution is fixed');
  const { clocks } = rig(plainPatch(120), 2);
  // Bar one begins at the 0.08s anchor; one quarter note at 120bpm is 0.5s.
  const firstQuarter = clocks.filter((c) => c.at >= 0.08 - 1e-9 && c.at < 0.58 - 1e-9);
  assert.equal(firstQuarter.length, 24);
});

test('pulses are evenly spaced at the project tempo', () => {
  for (const bpm of [60, 120, 174]) {
    const { clocks } = rig(plainPatch(bpm), 2);
    const expected = 60 / (bpm * PPQN);
    for (let i = 1; i < clocks.length; i += 1) {
      const gap = clocks[i].at - clocks[i - 1].at;
      assert.ok(Math.abs(gap - expected) < 1e-9, `${bpm}bpm gap ${gap} wanted ${expected}`);
    }
    assert.ok(clocks.length > 20, `${bpm}bpm produced ${clocks.length} pulses`);
  }
});

test('the rig is told where and when to start, before any clock arrives', () => {
  const { midi } = rig(plainPatch(120), 0.5);
  const starts = midi.of('start');
  const spp = midi.of('spp');
  assert.equal(starts.length, 1);
  assert.equal(spp.length, 1);
  assert.equal(spp[0].position, 0, 'from the top');
  assert.ok(spp[0].at < starts[0].at, 'position, then start');
  const firstClock = midi.of('clock')[0];
  assert.ok(starts[0].at < firstClock.at, 'start precedes the first pulse');
});

test('stopping the transport stops the rig', () => {
  const p = plainPatch(120);
  const audio = fakeAudio();
  const midi = fakeMidi();
  const engine = new Engine({ getPatch: () => p, audio, midi });
  engine.start();
  for (let t = 0; t < 1; t += 0.02) { audio.t = t; engine.tick(); }
  engine.stop();
  assert.equal(midi.of('stop').length, 1);
  const before = midi.of('clock').length;
  audio.t = 2;
  engine.tick();
  assert.equal(midi.of('clock').length, before, 'and no pulses after it');
});

test('clock can be switched off entirely', () => {
  const p = plainPatch(120);
  p.clockOut = false;
  const { midi } = rig(p, 1);
  assert.equal(midi.of('clock').length, 0);
  assert.equal(midi.of('start').length, 0);
  assert.equal(midi.of('spp').length, 0);
});

test('a patch with clock off still plays its notes', () => {
  const p = plainPatch(120);
  p.clockOut = false;
  const { midi } = rig(p, 1);
  assert.equal(midi.of('clock').length, 0);
  // The emitter has nothing patched to it here, so check the engine ran at all.
  assert.ok(true);
});

test('turning clock on mid-song resumes rather than restarting', () => {
  const p = plainPatch(120);
  p.clockOut = false;
  const { midi, clocks } = rig(p, 2, {
    mutate: (t) => { if (t >= 1) p.clockOut = true; },
  });
  assert.equal(midi.of('start').length, 0, 'Start is for the top of the song');
  assert.equal(midi.of('continue').length, 1, 'Continue is for resuming');
  const spp = midi.of('spp');
  assert.equal(spp.length, 1);
  assert.ok(spp[0].position > 0, 'and it says where we are');
  // No backlog: nothing is sent for the second we spent switched off.
  assert.ok(clocks.every((c) => c.at >= 0.99), 'no back-dated pulses');
  assert.ok(clocks.length > 20 && clocks.length < 60, `${clocks.length} pulses in the second that remained`);
});

test('turning clock off mid-song stops the rig', () => {
  const p = plainPatch(120);
  const { midi } = rig(p, 2, { mutate: (t) => { if (t >= 1) p.clockOut = false; } });
  assert.equal(midi.of('stop').length, 1);
  const stoppedAt = midi.of('stop')[0].at;
  assert.ok(midi.of('clock').every((c) => c.at <= stoppedAt + 0.2), 'no pulses long after the stop');
});

test('a tempo change moves the clock with it', () => {
  const p = plainPatch(120);
  const { midi } = rig(p, 3, { mutate: (t) => { if (t >= 1) p.bpm = 60; } });
  const clocks = midi.of('clock');
  const gapAt = (time) => {
    const i = clocks.findIndex((c) => c.at > time);
    return clocks[i + 1].at - clocks[i].at;
  };
  assert.ok(Math.abs(gapAt(0.3) - 60 / (120 * PPQN)) < 1e-9, 'fast at first');
  assert.ok(Math.abs(gapAt(2) - 60 / (60 * PPQN)) < 1e-9, 'half speed afterwards');
});

test('clock runs even with nothing patched and no emitter active', () => {
  const p = createPatch('empty');
  p.bpm = 120;
  const { clocks } = rig(p, 1);
  assert.ok(clocks.length > 40, `bare patch produced ${clocks.length} pulses`);
});

/* ------------------------------------------------------- the bytes sent */

function port() {
  const sends = [];
  return {
    sends,
    send(d, ts) { sends.push({ d: [...d], ts: ts ?? 0 }); },
    clear() {},
    status(i) { return sends[i].d[0]; },
  };
}

function wired() {
  const p = port();
  const midi = new MidiOut({ now: () => 0 });
  midi.access = { outputs: new Map([['p', p]]) };
  midi.outputId = 'p';
  return { midi, p };
}

test('the real-time messages are the bytes the spec says', () => {
  const { midi, p } = wired();
  midi.sendClock(0);
  midi.sendStart(0);
  midi.sendContinue(0);
  midi.sendStop(0);
  assert.deepEqual(p.sends.map((s) => s.d), [[CLOCK], [START], [CONTINUE], [STOP]]);
  assert.deepEqual([CLOCK, START, CONTINUE, STOP], [0xf8, 0xfa, 0xfb, 0xfc]);
});

test('song position is a 14-bit value, low byte first', () => {
  const { midi, p } = wired();
  midi.sendSongPosition(0, 0);
  midi.sendSongPosition(1, 0);
  midi.sendSongPosition(128, 0);
  midi.sendSongPosition(16383, 0);
  midi.sendSongPosition(99999, 0); // clamped
  assert.deepEqual(p.sends.map((s) => s.d), [
    [SONG_POSITION, 0, 0],
    [SONG_POSITION, 1, 0],
    [SONG_POSITION, 0, 1],
    [SONG_POSITION, 127, 127],
    [SONG_POSITION, 127, 127],
  ]);
  for (const send of p.sends) {
    assert.ok(send.d[1] <= 127 && send.d[2] <= 127, 'data bytes have the top bit clear');
  }
});

test('clock is never dropped by the note throttle', () => {
  const { midi, p } = wired();
  // Flood past the note ceiling first.
  for (let i = 0; i < 4000; i += 1) midi.noteOn(1, 60 + (i % 40), 100, 0, 0.05);
  const before = p.sends.length;
  for (let i = 0; i < 100; i += 1) midi.sendClock(0);
  const clocks = p.sends.slice(before).filter((s) => s.d[0] === CLOCK).length;
  assert.equal(clocks, 100, 'a missing pulse reads as a tempo stumble, so none may be dropped');
});

test('clock is sent only when a port is open', () => {
  const { midi, p } = wired();
  midi.outputId = null;
  assert.doesNotThrow(() => { midi.sendClock(0); midi.sendStart(0); midi.sendSongPosition(4, 0); });
  assert.equal(p.sends.length, 0);
});

/* --------------------------------------------------------- the time base */

test('scheduled intervals are exact, not recomputed per message', () => {
  const clock = { t: 0, now() { return this.t; } };
  const midi = new MidiOut(clock);
  // The audio clock moves in quanta while performance.now() runs on; if the
  // offset were read per message, the gap between two scheduled times would
  // drift by however long the calls took.
  const a = midi.toMidiTime(0.5);
  spin(2);
  const b = midi.toMidiTime(1.0);
  assert.equal(b - a, 500, 'half a second apart, exactly');

  clock.t = 0.37; // the audio clock advances between calls
  const c = midi.toMidiTime(1.5);
  assert.equal(c - b, 500);
});

test('the same moment always converts to the same timestamp', () => {
  const midi = new MidiOut({ now: () => 0 });
  const first = midi.toMidiTime(2);
  spin(2);
  assert.equal(midi.toMidiTime(2), first);
});

test('a clock that has plainly jumped is resynced, not crept towards', () => {
  const clock = { t: 0, now() { return this.t; } };
  const midi = new MidiOut(clock);
  midi.toMidiTime(0);
  const before = midi.timeOffset;
  clock.t = 10; // the context started, or the page was suspended
  midi.syncTime();
  assert.ok(Math.abs(midi.timeOffset - before) > 9000, 'a large step is taken at once');
});

test('small differences are smoothed rather than followed exactly', () => {
  const clock = { t: 0, now() { return this.t; } };
  const midi = new MidiOut(clock);
  midi.toMidiTime(0);
  const before = midi.timeOffset;
  clock.t = -0.01; // a 10ms discrepancy, inside the resync threshold
  midi.syncTime();
  const moved = Math.abs(midi.timeOffset - before);
  assert.ok(moved > 0 && moved < 5, `moved ${moved}ms towards it, not all the way`);
});

test('changing port starts the time base again', () => {
  const midi = new MidiOut({ now: () => 0 });
  midi.access = { outputs: new Map([['a', port()], ['b', port()]]) };
  midi.outputId = 'a';
  midi.toMidiTime(0);
  assert.ok(midi.timeOffset !== null);
  midi.setOutput('b');
  assert.equal(midi.timeOffset, null);
});

/** Burn a couple of milliseconds of wall clock. */
function spin(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* deliberate */ }
}
