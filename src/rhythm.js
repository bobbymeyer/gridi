// Rhythmic feel. Everything a pulse emitter knows about *when* lives here.
//
// Deliberately geometry-free: where a node sits on the grid never affects
// timing. Feel is a property of the emitter, exactly as the design calls for.

import { clamp, wrap } from './util.js';

/** Note value -> length in beats (a beat being a quarter note). */
export const DIVISIONS = {
  '1/1': { label: '1/1', beats: 4 },
  '1/2': { label: '1/2', beats: 2 },
  '1/4': { label: '1/4', beats: 1 },
  '1/8': { label: '1/8', beats: 0.5 },
  '1/16': { label: '1/16', beats: 0.25 },
  '1/32': { label: '1/32', beats: 0.125 },
  '1/2T': { label: '1/2T', beats: 4 / 3 },
  '1/4T': { label: '1/4T', beats: 2 / 3 },
  '1/8T': { label: '1/8T', beats: 1 / 3 },
  '1/16T': { label: '1/16T', beats: 1 / 6 },
  '1/4.': { label: '1/4.', beats: 1.5 },
  '1/8.': { label: '1/8.', beats: 0.75 },
};

export const DIVISION_KEYS = Object.keys(DIVISIONS);

export const divisionBeats = (key) => (DIVISIONS[key] ?? DIVISIONS['1/16']).beats;

/**
 * Length of one step in beats, including any polyrhythm ratio.
 * ratio 3:4 means "three of these steps in the space of four", i.e. faster.
 */
export function stepBeats(division, ratioNum = 1, ratioDen = 1) {
  const n = Math.max(1, Math.round(ratioNum));
  const d = Math.max(1, Math.round(ratioDen));
  return divisionBeats(division) * (d / n);
}

/**
 * Onset of `step` in beats from the emitter's start, with swing applied.
 * Swing delays every odd step by a fraction of a step. 1/3 lands on triplets.
 */
export function stepOnsetBeats(step, beats, swing = 0) {
  const s = clamp(swing, 0, 0.75);
  const shift = step % 2 === 1 ? s * beats : 0;
  return step * beats + shift;
}

/**
 * Euclidean onset pattern: `pulses` hits spread as evenly as possible over
 * `steps`, rotated by `rotate`. E(3,8) gives the tresillo x..x..x.
 *
 * This is Bjorklund's algorithm rather than the one-line floor trick, which
 * produces a rotation of the canonical pattern for cases like E(5,8) -- and
 * where a rhythm starts is the whole point of it.
 */
export function euclid(pulses, steps, rotate = 0) {
  const n = Math.max(1, Math.round(steps));
  const p = clamp(Math.round(pulses), 0, n);
  if (p === 0) return new Array(n).fill(false);
  if (p === n) return new Array(n).fill(true);

  let head = Array.from({ length: p }, () => [true]);
  let tail = Array.from({ length: n - p }, () => [false]);
  while (tail.length > 1) {
    const pairs = Math.min(head.length, tail.length);
    const merged = [];
    for (let i = 0; i < pairs; i += 1) merged.push(head[i].concat(tail[i]));
    const rest = head.length > pairs ? head.slice(pairs) : tail.slice(pairs);
    head = merged;
    tail = rest;
  }
  const out = head.concat(tail).flat();

  if (!rotate) return out;
  return out.map((_, i) => out[wrap(i + rotate, n)]);
}

/** Render a pattern as `x..x..x.` for the inspector. */
export function patternString(pattern) {
  return pattern.map((on) => (on ? 'x' : '.')).join('');
}

/** Does this emitter fire on the given absolute step index? */
export function emitterFiresOn(step, params) {
  if (!params.euclidOn) return true;
  const pattern = euclid(params.euclidPulses, params.euclidSteps, params.euclidRotate);
  return pattern[wrap(step, pattern.length)];
}

export const beatsToSeconds = (beats, bpm) => (beats * 60) / bpm;
export const secondsToBeats = (sec, bpm) => (sec * bpm) / 60;
