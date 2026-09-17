// Declarative registry of node types.
//
// Everything here is data: labels, colours, and a parameter schema the
// inspector builds itself from. Behaviour lives in engine.js so this file stays
// free of audio, MIDI and DOM and can be unit tested on its own.

import { SCALE_KEYS, SCALES, DEGREE_MODES, NOTE_NAMES } from './music.js';
import { DIVISION_KEYS, DIVISIONS } from './rhythm.js';
import { WAVEFORMS, WAVE_LABELS } from './voice.js';
import { SHAPES, RATES, MIN_RESOLUTION, MAX_RESOLUTION } from './lfo.js';

const scaleOptions = () => SCALE_KEYS.map((k) => ({ value: k, label: SCALES[k].label }));
const rootOptions = () => NOTE_NAMES.map((n, i) => ({ value: i, label: n }));
const divisionOptions = () => DIVISION_KEYS.map((k) => ({ value: k, label: DIVISIONS[k].label }));
const degreeModeOptions = () =>
  Object.entries(DEGREE_MODES).map(([value, label]) => ({ value, label }));
const waveOptions = () => WAVEFORMS.map((w) => ({ value: w, label: WAVE_LABELS[w] }));
const shapeOptions = () => Object.entries(SHAPES).map(([value, label]) => ({ value, label }));
const rateOptions = () => Object.entries(RATES).map(([value, r]) => ({ value, label: r.label }));


export const NODE_TYPES = {
  pulse: {
    label: 'pulse',
    role: 'clock source',
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
      { key: 'running', label: 'active', type: 'toggle' },
      { key: 'division', label: 'division', type: 'select', options: divisionOptions },
      { key: 'swing', label: 'swing', type: 'slider', min: 0, max: 0.6, step: 0.01, format: 'percent' },
      { key: 'ratioNum', label: 'poly steps', type: 'number', min: 1, max: 16, step: 1 },
      { key: 'ratioDen', label: 'in the time of', type: 'number', min: 1, max: 16, step: 1, hint: 'Steps of the division above. 3 in 2 is a triplet feel across the bar.' },
      { key: 'humanize', label: 'humanize', type: 'slider', min: 0, max: 40, step: 1, unit: 'ms' },
      { key: 'euclidOn', label: 'Euclid', type: 'toggle' },
      { key: 'euclidPulses', label: 'hits', type: 'number', min: 0, max: 32, step: 1, when: (p) => p.euclidOn },
      { key: 'euclidSteps', label: 'steps', type: 'number', min: 1, max: 32, step: 1, when: (p) => p.euclidOn },
      { key: 'euclidRotate', label: 'rotate', type: 'number', min: -32, max: 32, step: 1, when: (p) => p.euclidOn },
      { key: 'pattern', label: 'pattern', type: 'readout', when: (p) => p.euclidOn },
      {
        key: 'scaleMode',
        label: 'key from',
        type: 'segmented',
        group: 'signal',
        options: () => [
          { value: 'project', label: 'project' },
          { value: 'set', label: 'this node' },
        ],
      },
      { key: 'root', label: 'key', type: 'select', options: rootOptions, group: 'signal', when: (p) => p.scaleMode === 'set' },
      { key: 'scale', label: 'scale', type: 'select', options: scaleOptions, group: 'signal', when: (p) => p.scaleMode === 'set' },
      { key: 'channel', label: 'base ch', type: 'number', min: 1, max: 16, step: 1, group: 'signal' },
      { key: 'velocity', label: 'velocity', type: 'slider', min: 1, max: 127, step: 1, group: 'signal' },
    ],
  },

  input: {
    label: 'MIDI in',
    role: 'played source',
    color: 'red',
    glyph: 'keys',
    inputs: 0,
    outputs: 'many',
    blurb: 'A note played on an attached keyboard sends a pulse from here.',
    defaults: {
      listen: 0,
      sets: 'key',
      base: 60,
      useVelocity: true,
      scaleMode: 'project',
      scale: 'minPent',
      root: 0,
      channel: 1,
      velocity: 100,
    },
    params: [
      {
        key: 'listen',
        label: 'listen on',
        type: 'number',
        min: 0,
        max: 16,
        step: 1,
        hint: 'Incoming MIDI channel. Zero listens to all of them.',
      },
      {
        key: 'sets',
        label: 'played note',
        type: 'segmented',
        options: () => [
          { value: 'key', label: 'key' },
          { value: 'transpose', label: 'transp' },
          { value: 'none', label: 'gate' },
        ],
        hint: 'Key retunes everything downstream. Transpose shifts it. Gate ignores the pitch.',
      },
      {
        key: 'base',
        label: 'centre',
        type: 'number',
        min: 0,
        max: 127,
        step: 1,
        when: (p) => p.sets === 'transpose',
        hint: 'The note that means no transposition.',
      },
      { key: 'useVelocity', label: 'use velocity', type: 'toggle' },
      { key: 'played', label: 'last played', type: 'readout' },
      {
        key: 'scaleMode',
        label: 'key from',
        type: 'segmented',
        group: 'signal',
        options: () => [
          { value: 'project', label: 'project' },
          { value: 'set', label: 'this node' },
        ],
      },
      { key: 'root', label: 'key', type: 'select', options: rootOptions, group: 'signal', when: (p) => p.scaleMode === 'set' && p.sets !== 'key' },
      { key: 'scale', label: 'scale', type: 'select', options: scaleOptions, group: 'signal', when: (p) => p.scaleMode === 'set' },
      { key: 'channel', label: 'base ch', type: 'number', min: 1, max: 16, step: 1, group: 'signal' },
      { key: 'velocity', label: 'velocity', type: 'slider', min: 1, max: 127, step: 1, group: 'signal', when: (p) => !p.useVelocity },
    ],
  },

  split: {
    label: 'split',
    role: 'fan out',
    color: 'blue',
    glyph: 'fork',
    inputs: 1,
    outputs: 'many',
    blurb: 'Sends one pulse down every outgoing line at once.',
    defaults: { stagger: 0 },
    params: [
      {
        key: 'stagger',
        label: 'stagger',
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
    label: 'logic',
    role: 'coincidence',
    color: 'ink',
    glyph: 'gate',
    inputs: 'many',
    outputs: 'many',
    blurb: 'Fires when incoming pulses line up inside a window.',
    defaults: { mode: 'all', count: 2, windowMs: 20 },
    params: [
      {
        key: 'mode',
        label: 'mode',
        type: 'segmented',
        options: () => [
          { value: 'all', label: 'aND' },
          { value: 'any', label: 'oR' },
          { value: 'count', label: 'n' },
          { value: 'xor', label: 'xOR' },
        ],
      },
      { key: 'count', label: 'needs', type: 'number', min: 1, max: 8, step: 1, when: (p) => p.mode === 'count' },
      { key: 'windowMs', label: 'window', type: 'slider', min: 1, max: 120, step: 1, unit: 'ms' },
    ],
  },

  chance: {
    label: 'chance',
    role: 'probability',
    color: 'yellow',
    glyph: 'half',
    inputs: 1,
    outputs: 'many',
    blurb: 'Lets a pulse through a set percentage of the time.',
    defaults: { probability: 60, mode: 'free' },
    params: [
      { key: 'probability', label: 'pass', type: 'slider', min: 0, max: 100, step: 1, unit: '%' },
      {
        key: 'mode',
        label: 'mode',
        type: 'segmented',
        options: () => [
          { value: 'free', label: 'free' },
          { value: 'drunk', label: 'drift' },
        ],
        hint: 'Drift nudges the odds up after a block, down after a pass.',
      },
    ],
  },

  router: {
    label: 'router',
    role: 'one of many',
    color: 'blue',
    glyph: 'router',
    inputs: 1,
    outputs: 'many',
    blurb: 'Sends each pulse down a single outgoing line.',
    defaults: { mode: 'cycle' },
    params: [
      {
        key: 'mode',
        label: 'mode',
        type: 'segmented',
        options: () => [
          { value: 'cycle', label: 'cycle' },
          { value: 'pingpong', label: 'ping' },
          { value: 'random', label: 'rand' },
          { value: 'shuffle', label: 'no rpt' },
        ],
      },
    ],
  },

  note: {
    label: 'note',
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
      { key: 'degree', label: 'degree', type: 'number', min: -21, max: 22, step: 1, format: 'ordinal' },
      { key: 'octave', label: 'octave', type: 'number', min: -1, max: 8, step: 1 },
      { key: 'degreeMode', label: 'overflow', type: 'select', options: degreeModeOptions },
      { key: 'velocity', label: 'velocity', type: 'slider', min: 0, max: 127, step: 1, hint: '0 follows the line.' },
      { key: 'length', label: 'length', type: 'slider', min: 0.02, max: 4, step: 0.02, unit: 'beat' },
      { key: 'ratchet', label: 'ratchet', type: 'number', min: 1, max: 8, step: 1 },
      { key: 'midiOn', label: 'send MIDI', type: 'toggle', group: 'output' },
      { key: 'audition', label: 'audible', type: 'toggle', group: 'output', hint: 'Built-in blip, for when no MIDI port is open.' },
      { key: 'resolved', label: 'now plays', type: 'readout', group: 'output' },
    ],
  },

  synth: {
    label: 'voice',
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
      { key: 'degree', label: 'degree', type: 'number', min: -21, max: 22, step: 1, format: 'ordinal' },
      { key: 'octave', label: 'octave', type: 'number', min: -1, max: 8, step: 1 },
      { key: 'degreeMode', label: 'overflow', type: 'select', options: degreeModeOptions },

      { key: 'aWave', label: 'wave', type: 'segmented', options: waveOptions, group: 'oscillator A' },
      { key: 'aOctave', label: 'octave', type: 'number', min: -3, max: 3, step: 1, group: 'oscillator A' },
      { key: 'aSemi', label: 'semitones', type: 'number', min: -12, max: 12, step: 1, group: 'oscillator A' },
      { key: 'aDetune', label: 'detune', type: 'slider', min: -50, max: 50, step: 1, unit: 'ct', group: 'oscillator A' },
      { key: 'aLevel', label: 'level', type: 'slider', min: 0, max: 1, step: 0.01, group: 'oscillator A' },

      { key: 'bWave', label: 'wave', type: 'segmented', options: waveOptions, group: 'oscillator B' },
      { key: 'bOctave', label: 'octave', type: 'number', min: -3, max: 3, step: 1, group: 'oscillator B' },
      { key: 'bSemi', label: 'semitones', type: 'number', min: -12, max: 12, step: 1, group: 'oscillator B' },
      { key: 'bDetune', label: 'detune', type: 'slider', min: -50, max: 50, step: 1, unit: 'ct', group: 'oscillator B' },
      { key: 'bLevel', label: 'level', type: 'slider', min: 0, max: 1, step: 0.01, group: 'oscillator B' },

      { key: 'cutoff', label: 'cutoff', type: 'slider', min: 80, max: 12000, step: 10, unit: 'Hz', group: 'filter' },
      { key: 'resonance', label: 'reso', type: 'slider', min: 0.1, max: 20, step: 0.1, group: 'filter' },
      {
        key: 'filterEnv',
        label: 'env depth',
        type: 'slider',
        min: 0,
        max: 4,
        step: 0.1,
        unit: 'oct',
        group: 'filter',
        hint: 'How far the envelope opens the filter above the cutoff.',
      },

      { key: 'attack', label: 'attack', type: 'slider', min: 0.001, max: 2, step: 0.001, unit: 's', group: 'envelope' },
      { key: 'decay', label: 'decay', type: 'slider', min: 0.005, max: 2, step: 0.005, unit: 's', group: 'envelope' },
      { key: 'sustain', label: 'sustain', type: 'slider', min: 0, max: 1, step: 0.01, group: 'envelope' },
      { key: 'release', label: 'release', type: 'slider', min: 0.005, max: 3, step: 0.005, unit: 's', group: 'envelope' },
      { key: 'length', label: 'gate', type: 'slider', min: 0.02, max: 4, step: 0.02, unit: 'beat', group: 'envelope', hint: 'How long the note is held before the release starts.' },
      { key: 'level', label: 'level', type: 'slider', min: 0, max: 1, step: 0.01, group: 'envelope' },
      {
        key: 'voices',
        label: 'voices',
        type: 'number',
        min: 1,
        max: 32,
        step: 1,
        group: 'envelope',
        hint: 'Notes this node holds at once. Past that, its oldest is stolen.',
      },
    ],
  },

  lfo: {
    label: 'LFO',
    role: 'moving value',
    color: 'blue',
    glyph: 'curve',
    inputs: 1,
    outputs: 'many',
    blurb: 'Sends a moving value down its lines many times a beat, so a sweep is a sweep and not a staircase.',
    defaults: {
      shape: 'sine',
      rate: '1bar',
      phase: 0,
      depth: 1,
      min: 0,
      max: 127,
      resolution: 24,
      reset: true,
      scaleMode: 'project',
      scale: 'minPent',
      root: 0,
      channel: 1,
      velocity: 100,
    },
    params: [
      { key: 'shape', label: 'shape', type: 'select', options: shapeOptions },
      { key: 'rate', label: 'cycle', type: 'select', options: rateOptions, hint: 'One turn of the shape, in musical time.' },
      { key: 'phase', label: 'phase', type: 'slider', min: 0, max: 1, step: 0.01, format: 'percent' },
      { key: 'depth', label: 'depth', type: 'slider', min: 0, max: 1, step: 0.01, format: 'percent' },
      { key: 'min', label: 'from', type: 'number', min: 0, max: 127, step: 1 },
      { key: 'max', label: 'to', type: 'number', min: 0, max: 127, step: 1 },
      {
        key: 'resolution',
        label: 'steps',
        type: 'number',
        min: MIN_RESOLUTION,
        max: MAX_RESOLUTION,
        step: 1,
        hint: 'Values sent per beat. Higher is smoother and busier on the wire.',
      },
      { key: 'reset', label: 'reset on pulse', type: 'toggle', hint: 'Patch a clock in to restart the shape.' },
      { key: 'value', label: 'now', type: 'readout' },
      {
        key: 'wired',
        label: 'goes to',
        type: 'readout',
        hint: 'Patch this into a Param node — that is what decides where the value lands.',
      },
      { key: 'channel', label: 'base ch', type: 'number', min: 1, max: 16, step: 1, group: 'signal' },
    ],
  },

  param: {
    label: 'param',
    role: 'modulator',
    color: 'blue',
    glyph: 'bars',
    inputs: 1,
    outputs: 'many',
    blurb: 'Changes a value instead of firing a note. Passes the pulse on.',
    defaults: {
      scope: 'node',
      target: '',
      param: '',
      cc: 74,
      mode: 'sequence',
      values: '1 3 5 7',
      amount: 1,
      min: 0,
      max: 127,
    },
    params: [
      {
        key: 'scope',
        label: 'scope',
        type: 'segmented',
        options: () => [
          { value: 'node', label: 'node' },
          { value: 'signal', label: 'signal' },
          { value: 'midi', label: 'cC' },
        ],
        hint: 'Signal edits the pulse itself, so everything downstream follows. CC sends it out.',
      },
      { key: 'target', label: 'target', type: 'nodeRef', when: (p) => p.scope === 'node' },
      { key: 'param', label: 'param', type: 'paramRef', when: (p) => p.scope === 'node' },
      {
        key: 'param',
        label: 'param',
        type: 'select',
        when: (p) => p.scope === 'signal',
        options: () => [
          { value: 'velocity', label: 'velocity' },
          { value: 'transpose', label: 'transpose' },
          { value: 'degreeShift', label: 'degree shift' },
        ],
      },
      {
        key: 'cc',
        label: 'controller',
        type: 'number',
        min: 0,
        max: 127,
        step: 1,
        when: (p) => p.scope === 'midi',
        hint: 'CC number. 1 is the mod wheel and 74 the filter cutoff, by convention.',
      },
      { key: 'ccTarget', label: 'sent to', type: 'readout', when: (p) => p.scope === 'midi' },
      {
        key: 'mode',
        label: 'mode',
        type: 'segmented',
        options: () => [
          { value: 'sequence', label: 'seq' },
          { value: 'random', label: 'rand' },
          { value: 'walk', label: 'walk' },
          { value: 'add', label: 'add' },
        ],
      },
      { key: 'values', label: 'values', type: 'text', when: (p) => p.mode === 'sequence', hint: 'Space separated.' },
      { key: 'amount', label: 'amount', type: 'number', step: 1, when: (p) => p.mode === 'add' || p.mode === 'walk' },
      { key: 'min', label: 'min', type: 'number', step: 1, when: (p) => p.mode !== 'sequence' },
      { key: 'max', label: 'max', type: 'number', step: 1, when: (p) => p.mode !== 'sequence' },
    ],
  },

  key: {
    label: 'key',
    role: 'modulation',
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
        label: 'mode',
        type: 'segmented',
        options: () => [
          { value: 'set', label: 'set' },
          { value: 'cycle', label: 'cycle' },
          { value: 'random', label: 'rand' },
        ],
      },
      { key: 'root', label: 'key', type: 'select', options: rootOptions, when: (p) => p.mode === 'set' },
      { key: 'scale', label: 'scale', type: 'select', options: scaleOptions, when: (p) => p.mode === 'set' },
      {
        key: 'steps',
        label: 'changes',
        type: 'text',
        when: (p) => p.mode !== 'set',
        hint: 'root:scale pairs, e.g. 0:minPent 5:major',
      },
      { key: 'transpose', label: 'transpose', type: 'number', min: -24, max: 24, step: 1, unit: 'st' },
      {
        key: 'latch',
        label: 'latch',
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
  lfo: ['phase', 'depth', 'min', 'max', 'resolution'],
};

export function typeMeta(type) {
  return NODE_TYPES[type] ?? NODE_TYPES.note;
}

export function defaultParams(type) {
  return { ...typeMeta(type).defaults };
}
