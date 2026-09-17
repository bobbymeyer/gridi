import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adsrPoints, filterPoints, envelopeEnd, oscMidi, oscHz, oscMix, midiToHz,
  isWaveform, WAVEFORMS,
} from '../src/voice.js';
import { defaultParams } from '../src/nodes.js';
import { deserialize, demoPatch, serialize } from '../src/model.js';

const env = { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.2 };
const at = (points, time) => points.find((p) => Math.abs(p.time - time) < 1e-9);

test('a held note walks attack, decay, sustain, release in order', () => {
  const points = adsrPoints(env, 1, 0, 0.5);
  assert.deepEqual(points, [
    { time: 0, value: 0, curve: 'set' },
    { time: 0.01, value: 1, curve: 'linear' },
    { time: 0.11, value: 0.5, curve: 'exponential' },
    { time: 0.5, value: 0.5, curve: 'exponential' },
    { time: 0.7, value: 0, curve: 'exponential' },
  ]);
  assert.equal(envelopeEnd(points), 0.7);
});

test('breakpoints always move forward in time', () => {
  for (const hold of [0.001, 0.005, 0.05, 0.11, 0.3, 4]) {
    const points = adsrPoints(env, 1, 3, hold);
    for (let i = 1; i < points.length; i += 1) {
      assert.ok(points[i].time > points[i - 1].time, `hold=${hold} point ${i}`);
    }
    assert.equal(points[0].value, 0, 'starts silent');
    assert.equal(points.at(-1).value, 0, 'ends silent');
  }
});

test('a note released during the attack leaves from where it got to', () => {
  const points = adsrPoints(env, 1, 0, 0.005); // half way up a 10ms attack
  assert.equal(points.length, 3);
  assert.equal(points[1].time, 0.005);
  assert.ok(Math.abs(points[1].value - 0.5) < 1e-9, 'not the full peak');
  assert.ok(Math.abs(points[2].time - 0.205) < 1e-9, 'release still runs its full length');
});

test('a note released during the decay leaves from part way down', () => {
  const points = adsrPoints(env, 1, 0, 0.06); // 50ms into a 100ms decay
  assert.equal(at(points, 0.01).value, 1, 'attack still peaked');
  const leaving = at(points, 0.06);
  assert.ok(leaving.value < 1 && leaving.value > 0.5, `expected between peak and sustain, got ${leaving.value}`);
});

test('zero sustain decays to silence and still releases', () => {
  const points = adsrPoints({ ...env, sustain: 0 }, 1, 0, 0.5);
  assert.equal(at(points, 0.11).value, 0);
  assert.equal(envelopeEnd(points), 0.7);
});

test('full sustain holds at the peak', () => {
  const points = adsrPoints({ ...env, sustain: 1 }, 0.8, 0, 0.5);
  assert.equal(at(points, 0.11).value, 0.8);
  assert.equal(at(points, 0.5).value, 0.8);
});

test('velocity scales the whole envelope, not its timing', () => {
  const loud = adsrPoints(env, 1, 0, 0.5);
  const soft = adsrPoints(env, 0.25, 0, 0.5);
  assert.deepEqual(loud.map((p) => p.time), soft.map((p) => p.time));
  assert.equal(soft[1].value, loud[1].value * 0.25);
});

test('degenerate envelope times are clamped, not left to break the ramp', () => {
  const points = adsrPoints({ attack: 0, decay: 0, sustain: 0.5, release: 0 }, 1, 0, 0.5);
  for (let i = 1; i < points.length; i += 1) {
    assert.ok(points[i].time > points[i - 1].time);
  }
});

test('the attack rises linearly and everything after it falls exponentially', () => {
  const points = adsrPoints(env, 1, 0, 0.5);
  assert.equal(points[0].curve, 'set');
  assert.equal(points[1].curve, 'linear', 'attack');
  for (const p of points.slice(2)) assert.equal(p.curve, 'exponential');
  // A note cut off mid-attack is still on the attack curve.
  assert.equal(adsrPoints(env, 1, 0, 0.005)[1].curve, 'linear');
});

test('the filter contour sweeps up by its depth in octaves and back', () => {
  const points = filterPoints(env, 1000, 2, 0, 0.5);
  assert.equal(points[0].value, 1000);
  assert.equal(points[1].value, 4000); // two octaves up
  assert.equal(points[2].value, 1000);
});

test('zero filter depth leaves the cutoff static', () => {
  const points = filterPoints(env, 1000, 0, 0, 0.5);
  assert.deepEqual(points, [{ time: 0, value: 1000, curve: 'set' }]);
});

test('the filter contour stays inside the audible range', () => {
  const points = filterPoints(env, 11000, 4, 0, 0.5);
  for (const p of points) assert.ok(p.value >= 20 && p.value <= 20000, `${p.value}Hz`);
});

test('oscillator octave and semitone offsets shift pitch', () => {
  assert.equal(oscMidi(60, 0, 0), 60);
  assert.equal(oscMidi(60, -1, 0), 48);
  assert.equal(oscMidi(60, 1, 7), 79);
  assert.ok(Math.abs(oscHz(69, 0, 0) - 440) < 1e-9);
  assert.ok(Math.abs(oscHz(69, -1, 0) - 220) < 1e-9);
  assert.ok(Math.abs(midiToHz(60) - 261.6255653) < 1e-6);
});

test('two oscillators mix rather than sum', () => {
  assert.deepEqual(oscMix(1, 1), { a: 0.5, b: 0.5 });
  assert.deepEqual(oscMix(1, 0), { a: 1, b: 0 });
  assert.deepEqual(oscMix(0, 0), { a: 0, b: 0 });
  const { a, b } = oscMix(0.3, 0.2); // already under unity, left alone
  assert.ok(Math.abs(a - 0.3) < 1e-9 && Math.abs(b - 0.2) < 1e-9);
});

test('every waveform the schema offers is a real Web Audio type', () => {
  for (const w of WAVEFORMS) assert.ok(isWaveform(w), w);
  assert.deepEqual(WAVEFORMS, ['sine', 'triangle', 'square', 'sawtooth']);
  assert.ok(!isWaveform('noise'));
  const d = defaultParams('synth');
  assert.ok(isWaveform(d.aWave));
  assert.ok(isWaveform(d.bWave));
});

test('an old single-waveform Voice patch migrates to two oscillators', () => {
  const old = {
    nodes: [{
      type: 'synth',
      col: 0,
      row: 0,
      params: { waveform: 'square', detune: 8, cutoff: 900, sustain: 0.1 },
    }],
  };
  const p = deserialize(JSON.stringify(old));
  const params = p.nodes[0].params;
  assert.equal(params.aWave, 'square');
  assert.equal(params.bWave, 'square', 'both oscillators keep the old waveform');
  assert.equal(params.aDetune, -8);
  assert.equal(params.bDetune, 8, 'the old symmetric detune is preserved');
  assert.equal(params.cutoff, 900, 'untouched params survive');
  assert.equal(params.sustain, 0.1);
  assert.ok(Math.abs(params.filterEnv - Math.log2(3.5)) < 1e-9, 'the old hard-coded sweep becomes a value');
  assert.equal(params.waveform, undefined, 'the replaced key is gone');
  assert.equal(params.detune, undefined);
});

test('a current Voice patch is not clobbered by the migration', () => {
  const p = demoPatch();
  const bass = p.nodes.find((n) => n.type === 'synth');
  const back = deserialize(serialize(p)).nodes.find((n) => n.type === 'synth');
  assert.deepEqual(back.params, bass.params);
  assert.equal(back.params.aWave, 'sawtooth');
  assert.equal(back.params.bWave, 'square');
});

test('unknown params are dropped on load', () => {
  const p = deserialize(JSON.stringify({
    nodes: [{ type: 'synth', col: 0, row: 0, params: { madeUp: 42 } }],
  }));
  assert.equal(p.nodes[0].params.madeUp, undefined);
});
