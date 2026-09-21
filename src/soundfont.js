// Playing a SoundFont.
//
// sf2.js says which samples a note is made of and what the file wants done to
// them. This turns one of those into Web Audio nodes: a buffer playing at a
// rate, through a filter, through an envelope, through a pan.
//
// `voicePlan` does the arithmetic and touches nothing, so what a note is
// supposed to sound like can be checked without a browser. `SoundFont` owns the
// buffers and the playing, and needs a real context.

import { clamp } from './util.js';
import {
  parseSf2, voicesFor, presetFor, realPresets, GEN,
  timecentsToSeconds, centibelsToGain, centsToHz,
} from './sf2.js';

/** Past this the release is cut short, so a voice cannot hang forever. */
const MAX_RELEASE = 6;
/** A sample's own rate is what the buffer is built at; nothing is resampled here. */
const MIN_ENVELOPE = 0.001;

/**
 * Everything needed to play one sample of one note, in seconds, Hz and ratios.
 *
 * @param {object} voice  one entry from `voicesFor`
 * @param {number} key  the note being played
 * @param {number} velocity  1-127
 * @returns {object}
 */
export function voicePlan(voice, key, velocity) {
  const { header, gens } = voice;
  const at = (id) => (typeof gens[id] === 'number' ? gens[id] : 0);

  // Where in the sample block this one starts and stops. The coarse offsets are
  // in blocks of 32768, which is how a 16-bit field addresses a big file.
  const start = header.start + at(GEN.startAddrsOffset) + at(GEN.startAddrsCoarseOffset) * 32768;
  const end = header.end + at(GEN.endAddrsOffset) + at(GEN.endAddrsCoarseOffset) * 32768;
  const loopStart = header.loopStart
    + at(GEN.startloopAddrsOffset) + at(GEN.startloopAddrsCoarseOffset) * 32768;
  const loopEnd = header.loopEnd
    + at(GEN.endloopAddrsOffset) + at(GEN.endloopAddrsCoarseOffset) * 32768;

  const root = gens[GEN.overridingRootKey] >= 0 ? gens[GEN.overridingRootKey] : header.rootKey;
  // Everything that moves the pitch, in cents, so one `detune` carries all of
  // it and the buffer always plays back at its own rate.
  const detune = (key - root) * at(GEN.scaleTuning)
    + at(GEN.coarseTune) * 100
    + at(GEN.fineTune)
    + header.correction;

  const attenuation = centibelsToGain(at(GEN.initialAttenuation));
  const sustain = centibelsToGain(clamp(at(GEN.sustainVolEnv), 0, 1440));

  return {
    sampleIndex: voice.sampleIndex,
    start,
    end: Math.max(end, start + 1),
    sampleRate: header.sampleRate || 44100,
    detune,
    // Velocity is not in the file's gift: the spec leaves it to the player, and
    // squaring it is the curve that feels right on a keyboard.
    gain: attenuation * (clamp(velocity, 1, 127) / 127) ** 2,
    loop: (at(GEN.sampleModes) & 1) === 1,
    loopStart: Math.max(loopStart - start, 0),
    loopEnd: Math.max(loopEnd - start, 1),
    pan: clamp(at(GEN.pan) / 500, -1, 1),
    cutoff: clamp(centsToHz(at(GEN.initialFilterFc)), 20, 20000),
    resonance: clamp(at(GEN.initialFilterQ) / 10, 0, 24), // centibels to dB
    envelope: {
      // -12000 timecents is the number the spec uses to mean none, and the
      // formula turns it into 0.977ms. For a stage that is either there or not
      // that is not a short delay, it is no delay, so it is taken as zero --
      // otherwise every note in a patch starts a millisecond late for no reason.
      delay: silentStage(at(GEN.delayVolEnv)),
      attack: Math.max(timecentsToSeconds(at(GEN.attackVolEnv)), MIN_ENVELOPE),
      hold: silentStage(at(GEN.holdVolEnv)),
      decay: Math.max(timecentsToSeconds(at(GEN.decayVolEnv)), MIN_ENVELOPE),
      sustain,
      release: clamp(timecentsToSeconds(at(GEN.releaseVolEnv)), MIN_ENVELOPE, MAX_RELEASE),
    },
  };
}

/** A delay or hold stage: none at the sentinel, its own length otherwise. */
const silentStage = (timecents) => (timecents <= -12000 ? 0 : Math.max(timecentsToSeconds(timecents), 0));

/**
 * The volume envelope, as breakpoints on the gain.
 *
 * Attack ramps linearly and everything after it falls exponentially, which is
 * what an instrument does and what the ear expects. Exponential ramps cannot
 * reach zero, so the tail lands on a number small enough to be silence.
 */
export function envelopePoints(plan, peak, at, holdFor) {
  const e = plan.envelope;
  const floor = 1e-4;
  const open = at + e.delay;
  const points = [{ time: open, value: floor, curve: 'linear' }];
  points.push({ time: open + e.attack, value: peak, curve: 'linear' });

  const held = open + e.attack + e.hold;
  points.push({ time: held, value: peak, curve: 'linear' });

  const sustained = Math.max(peak * e.sustain, floor);
  const decayEnd = held + e.decay;
  const decay = { time: decayEnd, value: sustained, curve: 'exponential' };

  // A note can be let go before its decay has finished, and a long attack can
  // outlast the note entirely. Where the envelope had got to is worked out
  // against the whole shape, but only the points that come before the release
  // are written down -- a ramp list has to be in time order.
  const off = Math.max(at + holdFor, held);
  const offValue = Math.max(valueAt([...points, decay], off), floor);
  if (decayEnd < off) points.push(decay);
  points.push({ time: off, value: offValue, curve: 'exponential' });
  points.push({ time: off + e.release, value: floor, curve: 'exponential' });
  return points;
}

/** Where a breakpoint list has got to at a given time. */
function valueAt(points, time) {
  if (time <= points[0].time) return points[0].value;
  for (let i = 1; i < points.length; i += 1) {
    if (time > points[i].time) continue;
    const a = points[i - 1];
    const b = points[i];
    const span = b.time - a.time;
    if (span <= 0) return b.value;
    const f = (time - a.time) / span;
    if (b.curve === 'linear') return a.value + (b.value - a.value) * f;
    return a.value * (b.value / a.value) ** f;
  }
  return points[points.length - 1].value;
}

/** When the last point is reached, which is when the voice can be let go. */
export const planEnd = (points) => points[points.length - 1].time;

/* ------------------------------------------------------------- the player */

/**
 * A loaded SoundFont, and the buffers made from it.
 *
 * Sample data is held once, as the sixteen-bit block the file arrived as. An
 * AudioBuffer is built the first time a sample is actually asked for and kept
 * after that, so loading a hundred-megabyte General MIDI font costs the memory
 * of the file plus the handful of sounds a patch really uses.
 */
export class SoundFont {
  /**
   * @param {ArrayBuffer} buffer  the file
   * @param {string} [label]  what to call it, if the file does not say
   */
  constructor(buffer, label = '') {
    this.font = parseSf2(buffer);
    this.label = this.font.name || label || 'SoundFont';
    this.buffers = new Map(); // sampleIndex -> AudioBuffer
    this.bytes = buffer.byteLength;
  }

  get presetCount() {
    return realPresets(this.font).length;
  }

  /** Every preset, for a list someone reads. */
  list() {
    return realPresets(this.font).map((p) => ({ bank: p.bank, program: p.program, name: p.name }));
  }

  /** Does this font have a sound for a bank and program? */
  has(bank, program) {
    return Boolean(presetFor(this.font, bank, program));
  }

  /** What a note is made of: one plan per sample that should sound. */
  plansFor(bank, program, key, velocity) {
    const preset = presetFor(this.font, bank, program);
    if (!preset) return [];
    return voicesFor(this.font, preset, key, velocity).map((v) => voicePlan(v, key, velocity));
  }

  /**
   * The AudioBuffer for one sample, made on demand.
   *
   * Sample data is shared between zones, so the same buffer is handed out to
   * every voice that wants it -- a buffer source reads it, it never writes.
   */
  bufferFor(ctx, plan) {
    const key = `${plan.sampleIndex}:${plan.start}:${plan.end}`;
    const held = this.buffers.get(key);
    if (held) return held;

    const source = this.font.samples;
    const from = clamp(plan.start, 0, source.length);
    const to = clamp(plan.end, from, source.length);
    const length = Math.max(to - from, 1);
    const buffer = ctx.createBuffer(1, length, plan.sampleRate);
    const out = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) out[i] = source[from + i] / 32768;

    this.buffers.set(key, buffer);
    return buffer;
  }

  /** Drop the built buffers, keeping the file. */
  release() {
    this.buffers.clear();
  }
}

/**
 * Build one sounding voice on any context, and say when it goes quiet.
 *
 * Taking the context and destination as arguments means the same graph renders
 * offline in a test as plays live, which is how the rest of the audio in this
 * app is tested too.
 *
 * @returns {{source: AudioBufferSourceNode, amp: GainNode, stopAt: number}}
 */
export function buildSoundfontVoice(ctx, destination, font, plan, velocity, at, holdFor) {
  const source = ctx.createBufferSource();
  source.buffer = font.bufferFor(ctx, plan);
  source.detune.value = plan.detune;
  if (plan.loop && plan.loopEnd > plan.loopStart) {
    source.loop = true;
    source.loopStart = plan.loopStart / plan.sampleRate;
    source.loopEnd = plan.loopEnd / plan.sampleRate;
  }

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = plan.cutoff;
  filter.Q.value = plan.resonance;

  const amp = ctx.createGain();
  const points = envelopePoints(plan, plan.gain, at, holdFor);
  amp.gain.cancelScheduledValues(points[0].time);
  amp.gain.setValueAtTime(points[0].value, points[0].time);
  for (let i = 1; i < points.length; i += 1) {
    const { time, value, curve } = points[i];
    if (curve === 'linear') amp.gain.linearRampToValueAtTime(value, time);
    else amp.gain.exponentialRampToValueAtTime(value, time);
  }

  let tail = amp;
  if (plan.pan !== 0 && typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner();
    panner.pan.value = plan.pan;
    amp.connect(panner);
    tail = panner;
  }

  source.connect(filter);
  filter.connect(amp);
  tail.connect(destination);

  const stopAt = planEnd(points) + 0.01;
  source.start(at);
  return { source, amp, stopAt };
}
