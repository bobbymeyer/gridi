// Following someone else's clock.
//
// Sending clock is arithmetic; receiving it is estimation. Pulses arrive 24 to
// the quarter note over a transport that jitters, and the tempo they imply has
// to be recovered from their spacing without chasing every wobble.
//
// Two things are separated deliberately: the tempo, taken as the median of
// recent intervals so one late pulse cannot move it, and the phase, corrected a
// fraction at a time so the grid converges on the master rather than snapping
// to it. Snapping on every pulse would make the sequencer stutter 24 times a
// quarter note.

import { clamp } from './util.js';

export const PPQN = 24;

/** Outside this, the reading is noise rather than a tempo. */
export const MIN_BPM = 20;
export const MAX_BPM = 300;

/** Intervals kept for the median — one quarter note's worth. */
const WINDOW = PPQN;

/** How far from the median an interval may sit and still count towards tempo. */
export const OUTLIER_TOLERANCE = 0.25;

/** How much of the phase error to take out per pulse. */
export const PHASE_CORRECTION = 0.08;

/** Past this the grid is somewhere else entirely, so jump rather than creep. */
export const RESYNC_BEATS = 1;

export class ClockFollower {
  constructor() {
    this.reset();
  }

  reset() {
    this.intervals = [];
    this.lastPulse = null;
    this.pulses = 0;
    this.running = false;
    this.startedAt = null;
  }

  /** Transport messages from the master. */
  start(atBeat = 0) {
    this.intervals = [];
    this.lastPulse = null;
    this.pulses = Math.round(atBeat * PPQN);
    this.running = true;
  }

  /** Continue keeps the position and the tempo estimate it had. */
  resume() {
    this.lastPulse = null; // the gap across a pause is not an interval
    this.running = true;
  }

  stop() {
    this.running = false;
    this.lastPulse = null;
  }

  /** Song position, counted in sixteenth notes. */
  locate(sixteenths) {
    this.pulses = Math.max(0, Math.round(sixteenths)) * (PPQN / 4);
  }

  /**
   * One clock pulse arrived, in audio-clock seconds.
   * @returns {boolean} whether it was counted
   */
  pulse(at) {
    if (this.lastPulse !== null) {
      const gap = at - this.lastPulse;
      const bpm = gap > 0 ? 60 / (gap * PPQN) : 0;
      // A gap outside any plausible tempo means a dropped pulse or a stall;
      // count the pulse for position but keep it out of the tempo estimate.
      if (bpm >= MIN_BPM && bpm <= MAX_BPM) {
        this.intervals.push(gap);
        if (this.intervals.length > WINDOW) this.intervals.shift();
      }
    }
    this.lastPulse = at;
    this.pulses += 1;
    return true;
  }

  /** Where the master says we are, in beats. */
  get beat() {
    return this.pulses / PPQN;
  }

  /** Enough pulses to trust the estimate? Roughly an eighth note's worth. */
  get locked() {
    return this.intervals.length >= 6;
  }

  /**
   * Tempo implied by recent pulses, or null before there is enough to say.
   *
   * The median finds the centre, because one late pulse must not move it. But
   * the median alone reads a quantised stream wrong: USB MIDI is polled about
   * once a millisecond, so a 27.78ms interval arrives as a run of 28s and the
   * median takes 28 at face value — measured, that is 89.3bpm read from a
   * master running at 90. So the median only decides which intervals to trust,
   * and the tempo is the mean of those, which averages the quantisation out.
   */
  get tempo() {
    if (!this.locked) return null;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    const kept = this.intervals.filter((gap) => Math.abs(gap - median) <= median * OUTLIER_TOLERANCE);
    const centre = kept.length
      ? kept.reduce((total, gap) => total + gap, 0) / kept.length
      : median;
    return clamp(60 / (centre * PPQN), MIN_BPM, MAX_BPM);
  }

  /**
   * How far the local grid is behind the master, in beats. Positive means the
   * master is ahead and the grid should move forward.
   */
  errorAgainst(localBeat) {
    return this.beat - localBeat;
  }

  /** How much of that error to apply now: all of it when badly out, a sip otherwise. */
  correctionFor(localBeat) {
    const error = this.errorAgainst(localBeat);
    if (Math.abs(error) > RESYNC_BEATS) return { error, jump: true, delta: error };
    return { error, jump: false, delta: error * PHASE_CORRECTION };
  }
}
