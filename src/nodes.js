// Declarative registry of node types.
//
// Everything here is data: labels, colours, and a parameter schema the
// inspector builds itself from. Behaviour lives in engine.js so this file stays
// free of audio, MIDI and DOM and can be unit tested on its own.

import { SCALE_KEYS, SCALES, DEGREE_MODES, NOTE_NAMES } from './music.js';
import { DIVISION_KEYS, DIVISIONS } from './rhythm.js';
import { WAVEFORMS, WAVE_LABELS } from './voice.js';

const scaleOptions = () => SCALE_KEYS.map((k) => ({ value: k, label: SCALES[k].label }));
const rootOptions = () => NOTE_NAMES.map((n, i) => ({ value: i, label: n }));
const divisionOptions = () => DIVISION_KEYS.map((k) => ({ value: k, label: DIVISIONS[k].label }));
const degreeModeOptions = () =>
  Object.entries(DEGREE_MODES).map(([value, label]) => ({ value, label }));
const waveOptions = () => WAVEFORMS.map((w) => ({ value: w, label: WAVE_LABELS[w] }));


export const NODE_TYPES = {
  pulse: {
    label: 'Pulse',
    role: 'Clock source',
    color: 'red',
    glyph: 'circle',
    inputs: 0,
    outputs: 'many',
    blurb: 'Root clock. Owns feel and the starting key.',
    defaults: {
      division: '1/16',
      ratioNum: 1,
      ratioDen: 1,
      swing: 0,
      humanize: 0,
      euclidOn: false,
      euclidPulses: 3,
      euclidSteps: 8,
      euclidRotate: 0,
      scaleMode: 'project',
      scale: 'minPent',
      root: 0,
      channel: 1,
      velocity: 100,
      running: true,
    },
    params: [
      { key: 'running', label: 'Active', type: 'toggle' },
      { key: 'division', label: 'Division', type: 'select', options: divisionOptions },
      { key: 'swing', label: 'Swing', type: 'slider', min: 0, max: 0.6, step: 0.01, format: 'percent' },
      { key: 'ratioNum', label: 'Poly', type: 'number', min: 1, max: 16, step: 1, hint: 'over' },
      { key: 'ratioDen', label: '×', type: 'number', min: 1, max: 16, step: 1 },
      { key: 'humanize', label: 'Humanize', type: 'slider', min: 0, max: 40, step: 1, unit: 'ms' },
      { key: 'euclidOn', label: 'Euclid', type: 'toggle' },
      { key: 'euclidPulses', label: 'Hits', type: 'number', min: 0, max: 32, step: 1, when: (p) => p.euclidOn },
      { key: 'euclidSteps', label: 'Steps', type: 'number', min: 1, max: 32, step: 1, when: (p) => p.euclidOn },
      { key: 'euclidRotate', label: 'Rotate', type: 'number', min: -32, max: 32, step: 1, when: (p) => p.euclidOn },
      { key: 'pattern', label: 'Pattern', type: 'readout', when: (p) => p.euclidOn },
      {
        key: 'scaleMode',
        label: 'Key from',
        type: 'segmented',
        group: 'Signal',
        options: () => [
          { value: 'project', label: 'Project' },
          { value: 'set', label: 'This node' },
        ],
      },
      { key: 'root', label: 'Key', type: 'select', options: rootOptions, group: 'Signal', when: (p) => p.scaleMode === 'set' },
      { key: 'scale', label: 'Scale', type: 'select', options: scaleOptions, group: 'Signal', when: (p) => p.scaleMode === 'set' },
      { key: 'channel', label: 'Base ch', type: 'number', min: 1, max: 16, step: 1, group: 'Signal' },
      { key: 'velocity', label: 'Velocity', type: 'slider', min: 1, max: 127, step: 1, group: 'Signal' },
    ],
  },

  split: {
    label: 'Split',
    role: 'Fan out',
    color: 'blue',
    glyph: 'fork',
    inputs: 1,
    outputs: 'many',
    blurb: 'Sends one pulse down every outgoing line at once.',
    defaults: { stagger: 0 },
    params: [
      {
        key: 'stagger',
        label: 'Stagger',
        type: 'slider',
        min: 0,
        max: 0.5,
        step: 0.01,
        unit: 'beat',
        hint: 'Offsets each branch for flams.',
      },
    ],
  },

  gate: {
    label: 'Logic',
    role: 'Coincidence',
    color: 'ink',
    glyph: 'gate',
    inputs: 'many',
    outputs: 'many',
    blurb: 'Fires when incoming pulses line up inside a window.',
    defaults: { mode: 'all', count: 2, windowMs: 20 },
    params: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'segmented',
        options: () => [
          { value: 'all', label: 'AND' },
          { value: 'any', label: 'OR' },
          { value: 'count', label: 'N' },
          { value: 'xor', label: 'XOR' },
        ],
      },
      { key: 'count', label: 'Needs', type: 'number', min: 1, max: 8, step: 1, when: (p) => p.mode === 'count' },
      { key: 'windowMs', label: 'Window', type: 'slider', min: 1, max: 120, step: 1, unit: 'ms' },
    ],
  },

  chance: {
    label: 'Chance',
    role: 'Probability',
    color: 'yellow',
    glyph: 'half',
    inputs: 1,
    outputs: 'many',
    blurb: 'Lets a pulse through a set percentage of the time.',
    defaults: { probability: 60, mode: 'free' },
    params: [
      { key: 'probability', label: 'Pass', type: 'slider', min: 0, max: 100, step: 1, unit: '%' },
      {
        key: 'mode',
        label: 'Mode',
        type: 'segmented',
        options: () => [
          { value: 'free', label: 'Free' },
          { value: 'drunk', label: 'Drift' },
        ],
        hint: 'Drift nudges the odds up after a block, down after a pass.',
      },
    ],
  },

  router: {
    label: 'Router',
    role: 'One of many',
    color: 'blue',
    glyph: 'router',
    inputs: 1,
    outputs: 'many',
    blurb: 'Sends each pulse down a single outgoing line.',
    defaults: { mode: 'cycle' },
    params: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'segmented',
        options: () => [
          { value: 'cycle', label: 'Cycle' },
          { value: 'pingpong', label: 'Ping' },
          { value: 'random', label: 'Rand' },
          { value: 'shuffle', label: 'No rpt' },
        ],
      },
    ],
  },

  note: {
    label: 'Note',
    role: 'MIDI trigger',
    color: 'ink',
    glyph: 'diamond',
    inputs: 1,
    outputs: 'many',
    blurb: 'Fires a scale degree as MIDI on every channel the line carries.',
    defaults: {
      degree: 1,
      octave: 3,
      degreeMode: 'extend',
      velocity: 0,
      length: 0.25,
      midiOn: true,
      audition: true,
      ratchet: 1,
    },
    params: [
      { key: 'degree', label: 'Degree', type: 'number', min: -21, max: 22, step: 1, format: 'ordinal' },
      { key: 'octave', label: 'Octave', type: 'number', min: -1, max: 8, step: 1 },
      { key: 'degreeMode', label: 'Overflow', type: 'select', options: degreeModeOptions },
      { key: 'velocity', label: 'Velocity', type: 'slider', min: 0, max: 127, step: 1, hint: '0 follows the line.' },
      { key: 'length', label: 'Length', type: 'slider', min: 0.02, max: 4, step: 0.02, unit: 'beat' },
      { key: 'ratchet', label: 'Ratchet', type: 'number', min: 1, max: 8, step: 1 },
      { key: 'midiOn', label: 'Send MIDI', type: 'toggle', group: 'Output' },
      { key: 'audition', label: 'Audible', type: 'toggle', group: 'Output', hint: 'Built-in blip, for when no MIDI port is open.' },
      { key: 'resolved', label: 'Now plays', type: 'readout', group: 'Output' },
    ],
  },

  synth: {
    label: 'Voice',
    role: 'Web Audio',
    color: 'yellow',
    glyph: 'wave',
    inputs: 1,
    outputs: 'many',
    blurb: 'Two oscillators, a resonant filter and an ADSR, rendered in the browser.',
    defaults: {
      degree: 1,
      octave: 2,
      degreeMode: 'extend',

      aWave: 'sawtooth',
      aOctave: 0,
      aSemi: 0,
      aDetune: -7,
      aLevel: 0.7,

      bWave: 'square',
      bOctave: -1,
      bSemi: 0,
      bDetune: 7,
      bLevel: 0.45,

      cutoff: 1800,
      resonance: 6,
      filterEnv: 1.8,

      attack: 0.004,
      decay: 0.14,
      sustain: 0.25,
      release: 0.18,
      length: 0.25,
      level: 0.35,
      voices: 8,
    },
    params: [
      { key: 'degree', label: 'Degree', type: 'number', min: -21, max: 22, step: 1, format: 'ordinal' },
      { key: 'octave', label: 'Octave', type: 'number', min: -1, max: 8, step: 1 },
      { key: 'degreeMode', label: 'Overflow', type: 'select', options: degreeModeOptions },

      { key: 'aWave', label: 'Wave', type: 'segmented', options: waveOptions, group: 'Oscillator A' },
      { key: 'aOctave', label: 'Octave', type: 'number', min: -3, max: 3, step: 1, group: 'Oscillator A' },
      { key: 'aSemi', label: 'Semitones', type: 'number', min: -12, max: 12, step: 1, group: 'Oscillator A' },
      { key: 'aDetune', label: 'Detune', type: 'slider', min: -50, max: 50, step: 1, unit: 'ct', group: 'Oscillator A' },
      { key: 'aLevel', label: 'Level', type: 'slider', min: 0, max: 1, step: 0.01, group: 'Oscillator A' },

      { key: 'bWave', label: 'Wave', type: 'segmented', options: waveOptions, group: 'Oscillator B' },
      { key: 'bOctave', label: 'Octave', type: 'number', min: -3, max: 3, step: 1, group: 'Oscillator B' },
      { key: 'bSemi', label: 'Semitones', type: 'number', min: -12, max: 12, step: 1, group: 'Oscillator B' },
      { key: 'bDetune', label: 'Detune', type: 'slider', min: -50, max: 50, step: 1, unit: 'ct', group: 'Oscillator B' },
      { key: 'bLevel', label: 'Level', type: 'slider', min: 0, max: 1, step: 0.01, group: 'Oscillator B' },

      { key: 'cutoff', label: 'Cutoff', type: 'slider', min: 80, max: 12000, step: 10, unit: 'Hz', group: 'Filter' },
      { key: 'resonance', label: 'Reso', type: 'slider', min: 0.1, max: 20, step: 0.1, group: 'Filter' },
      {
        key: 'filterEnv',
        label: 'Env depth',
        type: 'slider',
        min: 0,
        max: 4,
        step: 0.1,
        unit: 'oct',
        group: 'Filter',
        hint: 'How far the envelope opens the filter above the cutoff.',
      },

      { key: 'attack', label: 'Attack', type: 'slider', min: 0.001, max: 2, step: 0.001, unit: 's', group: 'Envelope' },
      { key: 'decay', label: 'Decay', type: 'slider', min: 0.005, max: 2, step: 0.005, unit: 's', group: 'Envelope' },
      { key: 'sustain', label: 'Sustain', type: 'slider', min: 0, max: 1, step: 0.01, group: 'Envelope' },
      { key: 'release', label: 'Release', type: 'slider', min: 0.005, max: 3, step: 0.005, unit: 's', group: 'Envelope' },
      { key: 'length', label: 'Gate', type: 'slider', min: 0.02, max: 4, step: 0.02, unit: 'beat', group: 'Envelope', hint: 'How long the note is held before the release starts.' },
      { key: 'level', label: 'Level', type: 'slider', min: 0, max: 1, step: 0.01, group: 'Envelope' },
      {
        key: 'voices',
        label: 'Voices',
        type: 'number',
        min: 1,
        max: 32,
        step: 1,
        group: 'Envelope',
        hint: 'Notes this node holds at once. Past that, its oldest is stolen.',
      },
    ],
  },

  param: {
    label: 'Param',
    role: 'Modulator',
    color: 'blue',
    glyph: 'bars',
    inputs: 1,
    outputs: 'many',
    blurb: 'Rewrites a parameter instead of firing a note. Passes the pulse on.',
    defaults: {
      scope: 'node',
      target: '',
      param: '',
      mode: 'sequence',
      values: '1 3 5 7',
      amount: 1,
      min: 0,
      max: 127,
    },
    params: [
      {
        key: 'scope',
        label: 'Scope',
        type: 'segmented',
        options: () => [
          { value: 'node', label: 'Node' },
          { value: 'signal', label: 'Signal' },
        ],
        hint: 'Signal edits the pulse itself, so everything downstream follows.',
      },
      { key: 'target', label: 'Target', type: 'nodeRef', when: (p) => p.scope === 'node' },
      { key: 'param', label: 'Param', type: 'paramRef', when: (p) => p.scope === 'node' },
      {
        key: 'param',
        label: 'Param',
        type: 'select',
        when: (p) => p.scope === 'signal',
        options: () => [
          { value: 'velocity', label: 'Velocity' },
          { value: 'transpose', label: 'Transpose' },
          { value: 'degreeShift', label: 'Degree shift' },
        ],
      },
      {
        key: 'mode',
        label: 'Mode',
        type: 'segmented',
        options: () => [
          { value: 'sequence', label: 'Seq' },
          { value: 'random', label: 'Rand' },
          { value: 'walk', label: 'Walk' },
          { value: 'add', label: 'Add' },
        ],
      },
      { key: 'values', label: 'Values', type: 'text', when: (p) => p.mode === 'sequence', hint: 'Space separated.' },
      { key: 'amount', label: 'Amount', type: 'number', step: 1, when: (p) => p.mode === 'add' || p.mode === 'walk' },
      { key: 'min', label: 'Min', type: 'number', step: 1, when: (p) => p.mode !== 'sequence' },
      { key: 'max', label: 'Max', type: 'number', step: 1, when: (p) => p.mode !== 'sequence' },
    ],
  },

  key: {
    label: 'Key',
    role: 'Modulation',
    color: 'red',
    glyph: 'key',
    inputs: 1,
    outputs: 'many',
    blurb: 'Rewrites scale and key for everything downstream, live.',
    defaults: {
      mode: 'set',
      root: 0,
      scale: 'minPent',
      transpose: 0,
      steps: '0:minPent 5:minPent 3:major 7:mixolydian',
      latch: false,
    },
    params: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'segmented',
        options: () => [
          { value: 'set', label: 'Set' },
          { value: 'cycle', label: 'Cycle' },
          { value: 'random', label: 'Rand' },
        ],
      },
      { key: 'root', label: 'Key', type: 'select', options: rootOptions, when: (p) => p.mode === 'set' },
      { key: 'scale', label: 'Scale', type: 'select', options: scaleOptions, when: (p) => p.mode === 'set' },
      {
        key: 'steps',
        label: 'Changes',
        type: 'text',
        when: (p) => p.mode !== 'set',
        hint: 'root:scale pairs, e.g. 0:minPent 5:major',
      },
      { key: 'transpose', label: 'Transpose', type: 'number', min: -24, max: 24, step: 1, unit: 'st' },
      {
        key: 'latch',
        label: 'Latch',
        type: 'toggle',
        hint: 'Writes the project key, so the whole patch modulates and stays there.',
      },
    ],
  },
};

export const NODE_TYPE_KEYS = Object.keys(NODE_TYPES);

/** Params a Param node is allowed to drive on a given target type. */
export const MODULATABLE = {
  pulse: ['swing', 'humanize', 'euclidPulses', 'euclidRotate', 'velocity', 'root'],
  split: ['stagger'],
  gate: ['count', 'windowMs'],
  chance: ['probability'],
  router: [],
  note: ['degree', 'octave', 'velocity', 'length', 'ratchet'],
  synth: [
    'degree', 'octave', 'cutoff', 'resonance', 'filterEnv', 'level', 'length',
    'attack', 'decay', 'sustain', 'release',
    'aOctave', 'aSemi', 'aDetune', 'aLevel', 'bOctave', 'bSemi', 'bDetune', 'bLevel',
  ],
  param: ['amount'],
  key: ['root', 'transpose'],
};

export function typeMeta(type) {
  return NODE_TYPES[type] ?? NODE_TYPES.note;
}

export function defaultParams(type) {
  return { ...typeMeta(type).defaults };
}
