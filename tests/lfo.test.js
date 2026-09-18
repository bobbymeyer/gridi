// LFO shapes, and waves travelling the lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shapeValue, lfoAt, hashUnit, rateBeats, resolutionBeats, SHAPE_KEYS, RATE_KEYS,
  MIN_RESOLUTION, MAX_RESOLUTION,
} from '../src/lfo.js';
import { Engine } from '../src/engine.js';
import { createPatch, createNode, addNode, connect, createChannel } from '../src/model.js';
import { fakeMidi, fakeAudio } from './helpers.js';

/* ----------------------------------------------------------------- shapes */

test('every shape stays inside minus one to one', () => {
  for (const shape of SHAPE_KEYS) {
    for (let c = 0; c < 4; c += 0.013) {
      const v = shapeValue(shape, c);
      assert.ok(v >= -1 && v <= 1, `${shape} at ${c.toFixed(3)} gave ${v}`);
    }
  }
});

test('sine and triangle share their phase, so swapping them does not jump', () => {
  for (const c of [0, 0.25, 0.5, 0.75]) {
    assert.ok(Math.abs(shapeValue('sine', c) - shapeValue('triangle', c)) < 1e-9, `at ${c}`);
  }
});

test('ramp rises and saw falls', () => {
  assert.equal(shapeValue('ramp', 0), -1);
  assert.ok(shapeValue('ramp', 0.999) > 0.99, 'and reaches the top by the end of the cycle');
  assert.ok(shapeValue('ramp', 0.9) > shapeValue('ramp', 0.1));
  assert.ok(shapeValue('saw', 0.9) < shapeValue('saw', 0.1));
});

test('square is one half of the time and minus one the other', () => {
  assert.equal(shapeValue('square', 0.1), 1);
  assert.equal(shapeValue('square', 0.6), -1);
});

test('shapes repeat exactly, cycle after cycle', () => {
  for (const shape of ['sine', 'triangle', 'ramp', 'saw', 'square']) {
    for (const frac of [0.1, 0.4, 0.7]) {
      assert.ok(
        Math.abs(shapeValue(shape, frac) - shapeValue(shape, frac + 5)) < 1e-9,
        `${shape} at ${frac}`,
      );
    }
  }
});

test('random holds its value for a whole cycle, then takes a new one', () => {
  const a = shapeValue('random', 3.01);
  assert.equal(shapeValue('random', 3.99), a, 'held across the cycle');
  assert.notEqual(shapeValue('random', 4.01), a, 'and a new one after it');
});

test('drift eases between the values random would jump to', () => {
  const from = shapeValue('random', 2.0);
  const to = shapeValue('random', 3.0);
  const mid = shapeValue('drift', 2.5);
  assert.ok(Math.abs(mid - (from + to) / 2) < 1e-9, 'half way at half way');
  let previous = -Infinity;
  const rising = to > from;
  for (let f = 0; f < 1; f += 0.05) {
    const v = shapeValue('drift', 2 + f);
    assert.ok(rising ? v >= previous - 1e-9 : v <= previous + 1e-9, 'moves one way only');
    previous = v;
  }
});

test('the random shapes are the same every time, so a patch replays', () => {
  assert.equal(hashUnit(7, 1), hashUnit(7, 1));
  assert.notEqual(hashUnit(7, 1), hashUnit(7, 2), 'but differ between LFOs');
  assert.notEqual(hashUnit(7, 1), hashUnit(8, 1));
  for (let i = 0; i < 50; i += 1) {
    const h = hashUnit(i, 3);
    assert.ok(h >= 0 && h < 1, `${h}`);
  }
});

/* ------------------------------------------------------------- the range */

test('the value is mapped into the range asked for', () => {
  const p = { shape: 'sine', rate: '1bar', phase: 0, depth: 1, min: 0, max: 127 };
  assert.ok(Math.abs(lfoAt(p, 0) - 63.5) < 1e-9, 'starts in the middle');
  assert.ok(Math.abs(lfoAt(p, 1) - 127) < 1e-9, 'top at a quarter turn');
  assert.ok(Math.abs(lfoAt(p, 3) - 0) < 1e-9, 'bottom at three quarters');
});

test('depth narrows around the middle rather than shifting it', () => {
  const p = { shape: 'sine', rate: '1bar', phase: 0, depth: 0.5, min: 0, max: 127 };
  assert.ok(Math.abs(lfoAt(p, 0) - 63.5) < 1e-9);
  assert.ok(Math.abs(lfoAt(p, 1) - 95.25) < 1e-9, 'half as far up');
  const none = { ...p, depth: 0 };
  assert.ok(Math.abs(lfoAt(none, 1) - 63.5) < 1e-9, 'no depth is no movement');
});

test('an inverted range is still a range', () => {
  const p = { shape: 'ramp', rate: '1/4', phase: 0, depth: 1, min: 100, max: 20 };
  for (let b = 0; b < 2; b += 0.05) {
    const v = lfoAt(p, b);
    assert.ok(v >= 20 && v <= 100, `${v}`);
  }
});

test('phase turns the shape without changing its rate', () => {
  const p = { shape: 'sine', rate: '1bar', phase: 0.25, depth: 1, min: 0, max: 127 };
  assert.ok(Math.abs(lfoAt(p, 0) - 127) < 1e-9, 'a quarter turn in, it starts at the top');
});

test('rate is read in musical time', () => {
  assert.equal(rateBeats('1/4'), 1);
  assert.equal(rateBeats('1bar'), 4);
  assert.equal(rateBeats('4bar'), 16);
  for (const key of RATE_KEYS) assert.ok(rateBeats(key) > 0, key);
});

test('resolution is held where a stream of controllers stays sane', () => {
  assert.equal(resolutionBeats(24), 1 / 24);
  assert.equal(resolutionBeats(1000), 1 / MAX_RESOLUTION);
  assert.equal(resolutionBeats(0), 1 / 24, 'nonsense falls back to the default');
  assert.equal(resolutionBeats(-5), 1 / MIN_RESOLUTION, 'and a negative is clamped up');
  assert.ok(resolutionBeats(-5) > 0, 'never a zero step, which would not advance');
});

/* ------------------------------------------------------ waves on the wire */

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
  return {
    engine,
    midi,
    controls: midi.controls.filter((c) => c.at < seconds),
    notes: midi.notes.filter((n) => n.at < seconds),
    waves: pulses.filter((p) => p.wave && p.arriveTime < seconds),
    beats: pulses.filter((p) => !p.wave && p.arriveTime < seconds),
  };
}

/** lfo -> param(CC), with the line saying where the controller goes. */
function wavePatch(lfoOverrides = {}, lineSetup) {
  const p = createPatch('wave');
  p.bpm = 120;
  const lfo = addNode(p, createNode('lfo', 0, 0, {
    shape: 'sine', rate: '1/4', resolution: 24, min: 0, max: 127, ...lfoOverrides,
  }));
  const mod = addNode(p, createNode('param', 8, 0, { scope: 'midi', cc: 74 }));
  const line = connect(p, lfo.id, mod.id);
  if (lineSetup) lineSetup(line);
  return { p, lfo, mod, line };
}

test('an LFO sends a stream, not a step', () => {
  const { p } = wavePatch();
  const { controls } = run(p, 2);
  // 120bpm, 24 values a beat, two seconds: about 96.
  assert.ok(controls.length > 60, `only ${controls.length} values`);
  const values = controls.map((c) => c.value);
  assert.ok(Math.max(...values) > 110 && Math.min(...values) < 15, 'it covers its range');
  // Consecutive values step by a little, not by a lot: that is what smooth means.
  let worst = 0;
  for (let i = 1; i < values.length; i += 1) worst = Math.max(worst, Math.abs(values[i] - values[i - 1]));
  assert.ok(worst < 30, `biggest jump was ${worst}`);
});

test('the line says where the controller goes, as it does for notes', () => {
  const { p } = wavePatch({}, (line) => {
    line.channelMode = 'set';
    line.channels = [createChannel(4, 'A'), createChannel(11, 'B')];
  });
  const { controls } = run(p, 1);
  const first = controls.filter((c) => c.at === controls[0].at);
  assert.deepEqual(first.map((c) => `${c.slot}:${c.ch}`), ['A:4', 'B:11']);
});

test('a wave never triggers a note, however fast it runs', () => {
  const p = createPatch('no triggers');
  p.bpm = 120;
  const lfo = addNode(p, createNode('lfo', 0, 0, { resolution: 24 }));
  const note = addNode(p, createNode('note', 8, 0, { audition: false }));
  connect(p, lfo.id, note.id);
  const { notes } = run(p, 2);
  assert.equal(notes.length, 0, 'two dozen a beat would be two dozen notes');
});

test('a wave passes through a split to every branch', () => {
  const p = createPatch('fan');
  p.bpm = 120;
  const lfo = addNode(p, createNode('lfo', 0, 0, { resolution: 8 }));
  const split = addNode(p, createNode('split', 10, 0));
  connect(p, lfo.id, split.id);
  for (const [i, cc] of [21, 22].entries()) {
    const mod = addNode(p, createNode('param', 20, i * 8, { scope: 'midi', cc }));
    const line = connect(p, split.id, mod.id);
    line.channelMode = 'set';
    line.channels = [createChannel(1, 'A')];
  }
  // Waves walk the grid at the same rate pulses do, so the window has to cover
  // the longer of the two branches -- the second one is three rows down.
  const { controls } = run(p, 6);
  assert.ok(controls.some((c) => c.cc === 21));
  assert.ok(controls.some((c) => c.cc === 22));
});

test('a wave is stopped by the nodes that are about timing', () => {
  for (const type of ['gate', 'chance', 'router']) {
    const p = createPatch(type);
    p.bpm = 120;
    const lfo = addNode(p, createNode('lfo', 0, 0, { resolution: 8 }));
    const blocker = addNode(p, createNode(type, 6, 0, { probability: 100 }));
    const mod = addNode(p, createNode('param', 12, 0, { scope: 'midi', cc: 30 }));
    connect(p, lfo.id, blocker.id);
    const line = connect(p, blocker.id, mod.id);
    line.channelMode = 'set';
    line.channels = [createChannel(1, 'A')];
    const { controls } = run(p, 1);
    assert.equal(controls.length, 0, `${type} should not pass a wave on`);
  }
});

test('an LFO with nowhere to go sends nothing and does not misbehave', () => {
  const p = createPatch('lonely');
  p.bpm = 120;
  addNode(p, createNode('lfo', 0, 0));
  const { controls, notes } = run(p, 1);
  assert.equal(controls.length, 0);
  assert.equal(notes.length, 0);
});

test('a pulse into an LFO restarts its shape', () => {
  const { p, lfo } = wavePatch({ shape: 'ramp', rate: '1/2', reset: true }, (line) => {
    line.channelMode = 'set';
    line.channels = [createChannel(1, 'A')];
  });
  const clock = addNode(p, createNode('pulse', 0, 8, { division: '1/4' }));
  connect(p, clock.id, lfo.id);
  const { controls } = run(p, 2.2);
  // A ramp restarted every quarter note returns to the bottom that often.
  const lows = controls.filter((c) => c.value < 10).length;
  assert.ok(lows >= 3, `the ramp restarted ${lows} times`);
});

test('resolution decides how busy the wire gets', () => {
  const sparse = run(wavePatch({ resolution: 4 }).p, 2).controls.length;
  const dense = run(wavePatch({ resolution: 24 }).p, 2).controls.length;
  assert.ok(dense > sparse * 3, `${sparse} against ${dense}`);
});

test('waves are drawn as waves, not as pulses', () => {
  const { p } = wavePatch();
  const { waves, beats } = run(p, 1);
  assert.ok(waves.length > 20, 'the line shows them travelling');
  assert.equal(beats.length, 0, 'and none of them is a pulse');
});

test('two random LFOs do not move together', () => {
  const p = createPatch('two');
  p.bpm = 120;
  for (const [i, cc] of [40, 41].entries()) {
    const lfo = addNode(p, createNode('lfo', 0, i * 8, { shape: 'random', rate: '1/4', resolution: 8 }));
    const mod = addNode(p, createNode('param', 8, i * 8, { scope: 'midi', cc }));
    const line = connect(p, lfo.id, mod.id);
    line.channelMode = 'set';
    line.channels = [createChannel(1, 'A')];
  }
  const { controls } = run(p, 3);
  const a = controls.filter((c) => c.cc === 40).map((c) => c.value);
  const b = controls.filter((c) => c.cc === 41).map((c) => c.value);
  assert.ok(a.length && b.length);
  assert.notDeepEqual(a, b, 'each has its own seed');
});
