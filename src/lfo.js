// Low-frequency oscillator shapes.
//
// MIDI cannot carry a continuous value, so "continuous" here means densely
// sampled: the shape is evaluated on the beat grid many times a beat and sent
// as a stream of controller values. That is what every sequencer means by an
// LFO to CC, and it is the difference between a sweep and a staircase.
//
// Shapes are pure functions of position, with no state carried between calls.
// The random ones derive their values by hashing the cycle number, so an LFO
// resumes mid-song exactly as it would have run, and two passes over the same
// bar give the same result.

import { clamp } from './util.js';

export const SHAPES = {
  sine: 'Sine',
  triangle: 'Triangle',
  ramp: 'Ramp',
  saw: 'Saw',
  square: 'Square',
  random: 'Random',
  drift: 'Drift',
};

export const SHAPE_KEYS = Object.keys(SHAPES);

/** Cycle length in beats. Everything is tempo-relative; a sequencer has no use for Hz. */
export const RATES = {
  '1/16': { label: '1/16', beats: 0.25 },
  '1/8': { label: '1/8', beats: 0.5 },
  '1/4': { label: '1/4', beats: 1 },
  '1/2': { label: '1/2', beats: 2 },
  '1bar': { label: '1 bar', beats: 4 },
  '2bar': { label: '2 bars', beats: 8 },
  '4bar': { label: '4 bars', beats: 16 },
  '8bar': { label: '8 bars', beats: 32 },
};

export const RATE_KEYS = Object.keys(RATES);
export const rateBeats = (key) => (RATES[key] ?? RATES['1bar']).beats;

/** Deterministic value in [0,1) for a cycle number. */
export function hashUnit(index, seed = 1) {
  let h = (Math.floor(index) ^ Math.floor(seed) * 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothstep, so Drift eases between its values instead of cornering. */
const ease = (t) => t * t * (3 - 2 * t);

/**
 * The shape's value in [-1, 1].
 *
 * @param {string} shape  a key of SHAPES
 * @param {number} cycles how many cycles have elapsed, fractional
 * @param {number} seed   distinguishes one random LFO from another
 */
export function shapeValue(shape, cycles, seed = 1) {
  const index = Math.floor(cycles);
  const frac = cycles - index;
  switch (shape) {
    case 'sine': return Math.sin(2 * Math.PI * frac);
    // Starts at zero, rises to one at a quarter, falls through zero at
    // three quarters — the same phase as the sine, which is what makes them
    // interchangeable without the patch jumping.
    case 'triangle': return frac < 0.25 ? frac * 4
      : frac < 0.75 ? 2 - frac * 4
        : frac * 4 - 4;
    case 'ramp': return frac * 2 - 1;
    case 'saw': return 1 - frac * 2;
    case 'square': return frac < 0.5 ? 1 : -1;
    case 'random': return hashUnit(index, seed) * 2 - 1;
    case 'drift': {
      const from = hashUnit(index, seed) * 2 - 1;
      const to = hashUnit(index + 1, seed) * 2 - 1;
      return from + (to - from) * ease(frac);
    }
    default: return 0;
  }
}

/**
 * The value an LFO should be putting out at a given beat, mapped into its
 * range. Phase is in cycles, so 0.25 is a quarter turn whatever the rate.
 */
export function lfoAt(params, beat, seed = 1) {
  const beats = Math.max(rateBeats(params.rate), 1 / 64);
  const cycles = beat / beats + (Number(params.phase) || 0);
  const raw = shapeValue(params.shape, cycles, seed);
  const lo = Number(params.min);
  const hi = Number(params.max);
  const mid = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  return clamp(mid + raw * half * clamp(Number(params.depth) ?? 1, 0, 1), Math.min(lo, hi), Math.max(lo, hi));
}

/** Samples per beat, held where a stream of controllers stays sane. */
export const MIN_RESOLUTION = 1;
export const MAX_RESOLUTION = 48;

export const resolutionBeats = (resolution) =>
  1 / clamp(Math.round(resolution) || 24, MIN_RESOLUTION, MAX_RESOLUTION);
