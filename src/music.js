// Scales, keys, and scale-degree resolution.
//
// Pitch in this app is *always* expressed as a scale degree plus an octave, and
// resolved late against whatever scale/key the traveling pulse is carrying. That
// is what makes a live key change possible: nothing downstream stores an
// absolute note number until the moment it fires.

import { wrap } from './util.js';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Semitone offsets from the root, one entry per degree. */
export const SCALES = {
  major: { label: 'major', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'nat minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  harmonic: { label: 'harm minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  melodic: { label: 'mel minor', steps: [0, 2, 3, 5, 7, 9, 11] },
  dorian: { label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { label: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { label: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { label: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  locrian: { label: 'Locrian', steps: [0, 1, 3, 5, 6, 8, 10] },
  majPent: { label: 'maj pent', steps: [0, 2, 4, 7, 9] },
  minPent: { label: 'min pent', steps: [0, 3, 5, 7, 10] },
  blues: { label: 'blues', steps: [0, 3, 5, 6, 7, 10] },
  wholeTone: { label: 'whole tone', steps: [0, 2, 4, 6, 8, 10] },
  chromatic: { label: 'chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

export const SCALE_KEYS = Object.keys(SCALES);

/**
 * How a degree past the end of the scale is handled. The brief left this open;
 * `extend` is the default because a 9th reading as "the 2nd, an octave up" is
 * what every musician expects.
 */
export const DEGREE_MODES = {
  extend: 'extend',
  fold: 'fold',
  clamp: 'clamp',
};

/**
 * Resolve a 1-based scale degree to a MIDI note number.
 *
 * @param {number} degree   1 = root. May exceed the scale length or go negative.
 * @param {string} scaleName key into SCALES
 * @param {number} root      pitch class of the key, 0 = C
 * @param {number} octave    octave of the root, MIDI convention (C4 = 60)
 * @param {string} mode      one of DEGREE_MODES
 */
export function resolveDegree(degree, scaleName, root = 0, octave = 4, mode = 'extend') {
  const scale = SCALES[scaleName] ?? SCALES.major;
  const steps = scale.steps;
  const len = steps.length;
  const idx = Math.round(degree) - 1;

  let semitones;
  if (mode === 'clamp') {
    semitones = steps[Math.min(Math.max(idx, 0), len - 1)];
  } else if (mode === 'fold') {
    semitones = steps[wrap(idx, len)];
  } else {
    const octaveShift = Math.floor(idx / len);
    semitones = steps[wrap(idx, len)] + 12 * octaveShift;
  }

  // MIDI 60 is C4, so the base of octave o is 12 * (o + 1).
  return 12 * (octave + 1) + root + semitones;
}

/** "C#3" for 49. Used in the inspector and the event log. */
export function noteName(midi) {
  const n = Math.round(midi);
  return `${NOTE_NAMES[wrap(n, 12)]}${Math.floor(n / 12) - 1}`;
}

/** Degrees this scale actually contains, for inspector hints. */
export function scaleLength(scaleName) {
  return (SCALES[scaleName] ?? SCALES.major).steps.length;
}

export function isValidMidi(n) {
  return Number.isFinite(n) && n >= 0 && n <= 127;
}
