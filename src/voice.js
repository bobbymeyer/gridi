// Synth maths for the Voice node.
//
// Kept separate from audio.js and free of Web Audio so the envelope and the
// oscillator tuning can be tested directly. ADSR bugs live in the awkward
// cases — a note released mid-attack, zero sustain, a decay longer than the
// note — and those are exactly the cases that are painful to hear-test.

import { clamp } from './util.js';

export const WAVEFORMS = ['sine', 'triangle', 'square', 'sawtooth'];
export const WAVE_LABELS = { sine: 'SIN', triangle: 'TRI', square: 'SQR', sawtooth: 'SAW' };

/** Web Audio cannot ramp to zero on an exponential curve. */
export const SILENCE = 0.0001;

export const midiToHz = (note) => 440 * 2 ** ((note - 69) / 12);

export const isWaveform = (w) => WAVEFORMS.includes(w);

/** An oscillator's own pitch: the voice's note, shifted by its octave and semitones. */
export function oscMidi(baseMidi, octave = 0, semitones = 0) {
  return baseMidi + 12 * Math.round(octave) + Math.round(semitones);
}

export function oscHz(baseMidi, octave = 0, semitones = 0) {
  return midiToHz(oscMidi(baseMidi, octave, semitones));
}

/**
 * ADSR as a list of {time, value, curve} breakpoints.
 *
 * The gate closes at `start + hold` whatever stage the envelope has reached, so
 * a short note released during the attack or the decay leaves from wherever it
 * actually got to rather than jumping to the sustain level first. Release is
 * always the last segment and always ends at silence.
 *
 * The attack is linear and everything after it is exponential. An exponential
 * rise out of near-silence is heavily back-loaded — a 200ms attack sits at a
 * third of its level with 10% of its time left, which reads as a late swell
 * rather than an attack. Falls are the opposite: exponential is what the ear
 * expects, and linear decays sound artificial.
 *
 * @param {{attack:number, decay:number, sustain:number, release:number}} env
 * @param {number} peak   the level the attack climbs to
 * @param {number} start  absolute start time
 * @param {number} hold   how long the gate stays open
 */
export function adsrPoints(env, peak, start, hold) {
  const attack = Math.max(env.attack ?? 0.005, 0.001);
  const decay = Math.max(env.decay ?? 0.1, 0.001);
  const sustain = clamp(env.sustain ?? 0.5, 0, 1);
  const release = Math.max(env.release ?? 0.1, 0.001);
  const top = Math.max(peak, 0);
  const sustainLevel = top * sustain;
  const gateOpen = Math.max(hold, 0.001);
  const off = start + gateOpen;

  const points = [{ time: start, value: 0, curve: 'set' }];
  if (off <= start + attack) {
    // Released during the attack: leave from the level actually reached.
    points.push({ time: off, value: top * ((off - start) / attack), curve: 'linear' });
  } else if (off <= start + attack + decay) {
    points.push({ time: start + attack, value: top, curve: 'linear' });
    const through = (off - (start + attack)) / decay;
    points.push({ time: off, value: top + (sustainLevel - top) * through, curve: 'exponential' });
  } else {
    points.push({ time: start + attack, value: top, curve: 'linear' });
    points.push({ time: start + attack + decay, value: sustainLevel, curve: 'exponential' });
    points.push({ time: off, value: sustainLevel, curve: 'exponential' });
  }
  points.push({ time: off + release, value: 0, curve: 'exponential' });
  return points;
}

/** When the voice has finished sounding and its oscillators can be stopped. */
export const envelopeEnd = (points) => points[points.length - 1].time;

/**
 * The filter's own contour: the same attack and decay shape, sweeping from the
 * cutoff up by `depth` octaves and back down. Depth 0 leaves it static.
 */
export function filterPoints(env, cutoff, depth, start, hold) {
  const base = clamp(cutoff, 20, 20000);
  if (!depth) return [{ time: start, value: base, curve: 'set' }];
  const attack = Math.max(env.attack ?? 0.005, 0.001);
  const decay = Math.max(env.decay ?? 0.1, 0.001);
  const top = clamp(base * 2 ** depth, 20, 20000);
  const points = [{ time: start, value: base, curve: 'set' }];
  const off = start + Math.max(hold, 0.001);
  if (off <= start + attack) {
    points.push({ time: off, value: base + (top - base) * ((off - start) / attack), curve: 'linear' });
    return points;
  }
  points.push({ time: start + attack, value: top, curve: 'linear' });
  points.push({ time: start + attack + decay, value: base, curve: 'exponential' });
  return points;
}

/**
 * Normalise the two oscillators so adding a second one does not double the
 * output level. Levels are a mix, not a sum.
 */
export function oscMix(levelA, levelB) {
  const a = clamp(levelA, 0, 1);
  const b = clamp(levelB, 0, 1);
  const total = a + b;
  if (total <= 0) return { a: 0, b: 0 };
  const scale = Math.min(1, 1 / total);
  return { a: a * scale, b: b * scale };
}
