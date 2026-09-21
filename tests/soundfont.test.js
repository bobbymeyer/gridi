// Turning a SoundFont voice into something that sounds.
//
// The arithmetic is checked here; the rendering is checked in
// tests/audio-check.html, which needs a browser to have an audio context.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSf2, voicesFor, realPresets, GEN, SAMPLE } from '../src/sf2.js';
import { voicePlan, envelopePoints, planEnd, SoundFont } from '../src/soundfont.js';
import { buildSf2, gen } from './sf2-fixture.js';

const font = (zones, presetZones = [[gen(GEN.instrument, 0)]], sample = {}) => parseSf2(buildSf2({
  pcm: Array.from({ length: 200 }, (_, i) => Math.round(Math.sin(i / 5) * 20000)),
  sample: { rootKey: 60, sampleRate: 22050, loopStart: 50, loopEnd: 150, ...sample },
  instrumentZones: zones,
  presetZones,
}));

// Full velocity, where the default modulators add nothing, so a plan shows the
// zone's own numbers. Velocity has its own tests.
const planFor = (f, key = 60, vel = 127) => {
  const voices = voicesFor(f, realPresets(f)[0], key, vel);
  assert.ok(voices.length, 'the fixture sounds on this key');
  return voicePlan(voices[0], key);
};

/* ----------------------------------------------------------------- pitch */

test('a note at the sample root plays the sample untouched', () => {
  const plan = planFor(font([[gen(GEN.sampleID, 0)]]), 60);
  assert.equal(plan.detune, 0);
  assert.equal(plan.sampleRate, 22050, 'and at its own rate, not the context rate');
});

test('an octave up is twelve hundred cents up', () => {
  assert.equal(planFor(font([[gen(GEN.sampleID, 0)]]), 72).detune, 1200);
  assert.equal(planFor(font([[gen(GEN.sampleID, 0)]]), 48).detune, -1200);
});

test('tuning, correction and the root override all land in the one number', () => {
  const f = font(
    [[gen(GEN.overridingRootKey, 69), gen(GEN.coarseTune, -2), gen(GEN.fineTune, 15), gen(GEN.sampleID, 0)]],
    [[gen(GEN.instrument, 0)]],
    { correction: 5 },
  );
  // Playing A4 against a root of A4: nothing from the key, then -200 from the
  // coarse tune, 15 from the fine and 5 from the sample's own correction.
  assert.equal(planFor(f, 69).detune, -180);
});

test('scale tuning of zero pins every key to the same pitch', () => {
  const f = font([[gen(GEN.scaleTuning, 0), gen(GEN.sampleID, 0)]]);
  assert.equal(planFor(f, 40).detune, 0);
  assert.equal(planFor(f, 90).detune, 0, 'which is what a drum kit wants');
});

/* ---------------------------------------------------------------- the sample */

test('a looping zone loops between the points the sample names', () => {
  const plan = planFor(font([[gen(GEN.sampleModes, 1), gen(GEN.sampleID, 0)]]));
  assert.equal(plan.loop, true);
  assert.deepEqual([plan.loopStart, plan.loopEnd], [50, 150]);
});

test('a zone that does not loop says so', () => {
  assert.equal(planFor(font([[gen(GEN.sampleID, 0)]])).loop, false);
});

test('address offsets move the window, coarse ones by thirty-two thousand', () => {
  const plan = planFor(font([[
    gen(GEN.startAddrsOffset, 10),
    gen(GEN.endAddrsOffset, -20),
    gen(GEN.sampleID, 0),
  ]]));
  assert.equal(plan.start, 10);
  assert.equal(plan.end, 180);
  // Loop points are relative to where the window starts, not to the file.
  assert.equal(plan.loopStart, 40);
});

/* -------------------------------------------------------------- loudness */

test('a zone attenuation is read straight off, at full velocity', () => {
  const quiet = planFor(font([[gen(GEN.initialAttenuation, 200), gen(GEN.sampleID, 0)]]), 60, 127);
  assert.ok(Math.abs(quiet.gain - 0.1) < 1e-6, '20dB down');
});

test('velocity quietens a voice, through the font rather than around it', () => {
  const f = font([[gen(GEN.sampleID, 0)]]);
  const full = planFor(f, 60, 127).gain;
  const half = planFor(f, 60, 64).gain;
  const soft = planFor(f, 60, 20).gain;
  assert.ok(Math.abs(full - 1) < 1e-9, 'nothing taken off at the top');
  // Six decibels at halfway, which is the default routing's doing, not a
  // curve applied here: the gain is whatever the attenuation came to.
  assert.ok(Math.abs(half - 0.5) < 0.02, `about half the amplitude, got ${half}`);
  assert.ok(soft < half && soft > 0, 'and quieter still further down');
});

test('velocity is counted once, not once here and once in the font', () => {
  const f = font([[gen(GEN.sampleID, 0)]]);
  const plan = planFor(f, 60, 64);
  // If a velocity curve were applied on top of the modulator, half velocity
  // would land near a quarter of the amplitude rather than a half.
  assert.ok(plan.gain > 0.4, `got ${plan.gain}, which looks like velocity twice`);
});

test('gain never leaves the range a gain node can use', () => {
  for (const cb of [-1000, 0, 500, 1440, 9000]) {
    for (const vel of [1, 64, 127]) {
      const g = planFor(font([[gen(GEN.initialAttenuation, cb), gen(GEN.sampleID, 0)]]), 60, vel).gain;
      assert.ok(Number.isFinite(g) && g >= 0 && g <= 1, `${cb}cb at velocity ${vel} gave ${g}`);
    }
  }
});

/* ------------------------------------------------------------- envelope */

test('an envelope opens, holds, falls to its sustain and then releases', () => {
  const plan = planFor(font([[
    gen(GEN.attackVolEnv, 0), // a second
    gen(GEN.holdVolEnv, 0),
    gen(GEN.decayVolEnv, 0),
    gen(GEN.sustainVolEnv, 200), // 20dB down
    gen(GEN.releaseVolEnv, 0),
    gen(GEN.sampleID, 0),
  ]]));
  const points = envelopePoints(plan, 1, 10, 5);
  assert.equal(points[0].time, 10, 'no delay, so it opens at once');
  assert.equal(points[1].time, 11, 'a second of attack');
  assert.equal(points[1].value, 1, 'to full');
  assert.equal(points[2].time, 12, 'a second of hold');
  assert.ok(Math.abs(points[3].value - 0.1) < 1e-6, 'decaying to a tenth');
  assert.equal(points[3].time, 13, 'a second of decay');
  assert.ok(points.every((p) => p.value > 0), 'and never to zero, which a ramp cannot reach');
  assert.ok(planEnd(points) > 15, 'the release outlives the note');
});

test('a note let go during its decay is released from where it had got to', () => {
  const plan = planFor(font([[
    gen(GEN.attackVolEnv, -12000),
    gen(GEN.decayVolEnv, 1200), // two seconds
    gen(GEN.sustainVolEnv, 0),
    gen(GEN.sampleID, 0),
  ]]));
  const points = envelopePoints(plan, 1, 0, 0.5);
  const off = points[points.length - 2];
  assert.ok(Math.abs(off.time - 0.5) < 0.01, 'let go when it was asked to be');
  assert.ok(off.value > 0 && off.value <= 1);
});

test('a note held past its envelope is not cut short', () => {
  const plan = planFor(font([[gen(GEN.attackVolEnv, 0), gen(GEN.sampleID, 0)]]));
  const points = envelopePoints(plan, 1, 0, 10);
  assert.ok(planEnd(points) > 10, 'the release starts after the hold, not during the attack');
});

test('the envelope is always in time order, whatever it is handed', () => {
  for (const hold of [0, 0.001, 0.5, 30]) {
    for (const attack of [-12000, 0, 2400]) {
      const plan = planFor(font([[gen(GEN.attackVolEnv, attack), gen(GEN.sampleID, 0)]]));
      const points = envelopePoints(plan, 1, 3, hold);
      for (let i = 1; i < points.length; i += 1) {
        assert.ok(points[i].time >= points[i - 1].time, `attack ${attack} held ${hold}`);
      }
    }
  }
});

test('a release is cut off before it can hang forever', () => {
  const plan = planFor(font([[gen(GEN.releaseVolEnv, 12000), gen(GEN.sampleID, 0)]])); // 100 seconds
  assert.ok(plan.envelope.release <= 6, `got ${plan.envelope.release}s`);
});

/* --------------------------------------------------------------- the font */

test('a SoundFont knows what it holds', () => {
  const sf = new SoundFont(buildSf2({
    name: 'Kit',
    pcm: [0, 1, 2, 3],
    instrumentZones: [[gen(GEN.sampleID, 0)]],
    presetZones: [[gen(GEN.instrument, 0)]],
    bank: 128,
    program: 0,
  }));
  assert.equal(sf.label, 'Kit');
  assert.equal(sf.presetCount, 1);
  assert.deepEqual(sf.list(), [{ bank: 128, program: 0, name: 'Test Preset' }]);
  assert.ok(sf.has(128, 0));
  assert.equal(sf.plansFor(128, 0, 60, 100).length, 1);
});

test('the same sample is only ever built into one buffer', () => {
  const sf = new SoundFont(buildSf2({
    pcm: Array.from({ length: 50 }, (_, i) => i * 100),
    instrumentZones: [
      [gen(GEN.keyRange, { lo: 0, hi: 127 }), gen(GEN.pan, -500), gen(GEN.sampleID, 0)],
      [gen(GEN.keyRange, { lo: 0, hi: 127 }), gen(GEN.pan, 500), gen(GEN.sampleID, 0)],
    ],
    presetZones: [[gen(GEN.instrument, 0)]],
  }));
  // A stand-in context: all the buffer builder needs is somewhere to put floats.
  const ctx = {
    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length);
      return { length, sampleRate, getChannelData: () => data };
    },
  };
  const plans = sf.plansFor(0, 0, 60, 100);
  assert.equal(plans.length, 2, 'two zones');
  const a = sf.bufferFor(ctx, plans[0]);
  const b = sf.bufferFor(ctx, plans[1]);
  assert.equal(a, b, 'and one buffer between them');
  assert.equal(sf.buffers.size, 1);
  assert.equal(a.length, 50);
  assert.ok(Math.abs(a.getChannelData(0)[10] - 1000 / 32768) < 1e-6, 'scaled to -1..1');
  sf.release();
  assert.equal(sf.buffers.size, 0);
});

/* ------------------------------------------------------- twenty-four bit */

/** Somewhere to put floats, which is all the buffer builder needs. */
const fakeCtx = () => ({
  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    return { length, sampleRate, getChannelData: () => data };
  },
});

test('sixteen bit samples land between minus one and one', () => {
  const sf = new SoundFont(buildSf2({
    pcm: [0, 32767, -32768, 16384],
    instrumentZones: [[gen(GEN.sampleID, 0)]],
    presetZones: [[gen(GEN.instrument, 0)]],
  }));
  const plan = sf.plansFor(0, 0, 60, 127)[0];
  const d = sf.bufferFor(fakeCtx(), plan).getChannelData(0);
  assert.equal(d[0], 0);
  assert.ok(Math.abs(d[1] - 32767 / 32768) < 1e-7, 'the top of the range');
  assert.equal(d[2], -1, 'and the bottom');
  assert.ok(Math.abs(d[3] - 0.5) < 1e-7);
});

test('a twenty-four bit sample is the two chunks put back together', () => {
  const sf = new SoundFont(buildSf2({
    //          high word        low byte    means
    pcm:    [0,        1,      -1,    32767, -32768],
    pcmLow: [0,      128,     255,      255,      0],
    instrumentZones: [[gen(GEN.sampleID, 0)]],
    presetZones: [[gen(GEN.instrument, 0)]],
  }));
  const plan = sf.plansFor(0, 0, 60, 127)[0];
  const d = sf.bufferFor(fakeCtx(), plan).getChannelData(0);
  const SCALE = 8388608; // two to the twenty-third
  assert.equal(d[0], 0, 'nothing is nothing');
  assert.ok(Math.abs(d[1] - 384 / SCALE) < 1e-9, 'high 1, low 128 is 384');
  assert.ok(Math.abs(d[2] - -1 / SCALE) < 1e-9, 'high -1, low 255 is -1');
  assert.ok(Math.abs(d[3] - 8388607 / SCALE) < 1e-9, 'the very top');
  assert.equal(d[4], -1, 'and the very bottom');
});

test('the extra byte is resolution, not a different sound', () => {
  const frames = 64;
  const pcm = Array.from({ length: frames }, (_, i) => Math.round(Math.sin(i / 5) * 20000));
  const plain = new SoundFont(buildSf2({
    pcm,
    instrumentZones: [[gen(GEN.sampleID, 0)]],
    presetZones: [[gen(GEN.instrument, 0)]],
  }));
  const deep = new SoundFont(buildSf2({
    pcm,
    pcmLow: Array.from({ length: frames }, () => 128),
    instrumentZones: [[gen(GEN.sampleID, 0)]],
    presetZones: [[gen(GEN.instrument, 0)]],
  }));
  const a = plain.bufferFor(fakeCtx(), plain.plansFor(0, 0, 60, 127)[0]).getChannelData(0);
  const b = deep.bufferFor(fakeCtx(), deep.plansFor(0, 0, 60, 127)[0]).getChannelData(0);
  let worst = 0;
  for (let i = 0; i < frames; i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  // Half a sixteen-bit step apart, everywhere. Any more and the two chunks
  // have been put together wrongly rather than at finer resolution.
  assert.ok(worst < 1 / 32768, `the same waveform, got ${worst} apart`);
  assert.ok(worst > 0, 'but not identical, because the extra byte is doing something');
});

test('a stereo pair becomes two buffers, one for each side', () => {
  const sf = new SoundFont(buildSf2({
    pcm: Array.from({ length: 30 }, (_, i) => i * 500),
    samples: [
      { name: 'wide-L', type: SAMPLE.left, link: 1, start: 0, end: 15 },
      { name: 'wide-R', type: SAMPLE.right, link: 0, start: 15, end: 30 },
    ],
    instrumentZones: [[gen(GEN.sampleID, 0)]],
    presetZones: [[gen(GEN.instrument, 0)]],
  }));
  const plans = sf.plansFor(0, 0, 60, 127);
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((p) => p.pan), [-1, 1], 'hard left and hard right');
  const ctx = fakeCtx();
  const left = sf.bufferFor(ctx, plans[0]);
  const right = sf.bufferFor(ctx, plans[1]);
  assert.notEqual(left, right, 'two different windows on the block');
  assert.equal(sf.buffers.size, 2);
  assert.ok(Math.abs(right.getChannelData(0)[0] - 15 * 500 / 32768) < 1e-6, 'the right half starts where it should');
});
