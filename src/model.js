// The patch document: nodes, lines, and the project settings around them.
//
// Lines are first-class objects, not drawn edges. A line owns MIDI channels,
// an optional scale/key override and a musical delay, because retrofitting that
// later would mean rewriting every consumer of the graph.

import { makeId, deepClone, clamp } from './util.js';
import { defaultParams, typeMeta, NODE_TYPES } from './nodes.js';
import { SCALES } from './music.js';
import { DIVISIONS } from './rhythm.js';
import { isWaveform } from './voice.js';
import { LIMITS } from './limits.js';
import { asSlot, DEFAULT_SLOT } from './midi.js';

export const PATCH_VERSION = 1;

export function createNode(type, col, row, params = {}) {
  return {
    id: makeId('n'),
    type,
    col: Math.round(col),
    row: Math.round(row),
    label: '',
    params: { ...defaultParams(type), ...params },
  };
}

/**
 * A channel carried by a line. Per-channel transpose and velocity mean one line
 * can feed, say, a bass part and a doubling pad with different weight.
 */
export function createChannel(ch = 1, out = DEFAULT_SLOT) {
  return { out: asSlot(out), ch: clamp(Math.round(ch), 1, 16), transpose: 0, velocity: null };
}

export function createLine(from, to, overrides = {}) {
  return {
    id: makeId('l'),
    from,
    to,
    channelMode: 'inherit', // 'inherit' | 'set'
    channels: [createChannel(1)],
    scaleMode: 'inherit', // 'inherit' | 'set'
    scale: 'minPent',
    root: 0,
    delay: 0, // beats. Geometry never affects timing; this is the only delay.
    muted: false,
    weight: 1, // routers pick weighted-random with this
    ...overrides,
  };
}

export function createPatch(name = 'Untitled') {
  return {
    version: PATCH_VERSION,
    name,
    bpm: 112,
    clockOut: true,
    root: 0,
    scale: 'minPent',
    seed: 1,
    nodes: [],
    lines: [],
    view: { x: 0, y: 0, zoom: 1 },
  };
}

export const nodeById = (patch, id) => patch.nodes.find((n) => n.id === id);
export const lineById = (patch, id) => patch.lines.find((l) => l.id === id);

/** Outgoing lines, in stable creation order, which is the order a Router uses. */
export const outgoing = (patch, nodeId) => patch.lines.filter((l) => l.from === nodeId);
export const incoming = (patch, nodeId) => patch.lines.filter((l) => l.to === nodeId);

export function addNode(patch, node) {
  patch.nodes.push(node);
  return node;
}

export function removeNode(patch, nodeId) {
  patch.nodes = patch.nodes.filter((n) => n.id !== nodeId);
  patch.lines = patch.lines.filter((l) => l.from !== nodeId && l.to !== nodeId);
  // Param nodes pointing at the deleted node lose their target rather than
  // silently modulating whatever id gets reused later.
  for (const n of patch.nodes) {
    if (n.type === 'param' && n.params.target === nodeId) {
      n.params.target = '';
      n.params.param = '';
    }
  }
}

export function removeLine(patch, lineId) {
  patch.lines = patch.lines.filter((l) => l.id !== lineId);
}

/** Connecting is rejected for self-loops, duplicates and inputless targets. */
export function canConnect(patch, fromId, toId) {
  if (!fromId || !toId || fromId === toId) return false;
  const target = nodeById(patch, toId);
  const source = nodeById(patch, fromId);
  if (!target || !source) return false;
  if (typeMeta(target.type).inputs === 0) return false;
  if (typeMeta(source.type).outputs === 0) return false;
  if (patch.lines.some((l) => l.from === fromId && l.to === toId)) return false;
  return true;
}

export function connect(patch, fromId, toId, overrides) {
  if (!canConnect(patch, fromId, toId)) return null;
  const line = createLine(fromId, toId, overrides);
  patch.lines.push(line);
  return line;
}

/**
 * Display string for a line's channel set. Channels are grouped by the output
 * they go to, and the slot letter is only shown once more than one is in play,
 * so the ordinary single-device case stays quiet: "CH 1,4" against
 * "A:1,4 B:10".
 */
export function channelSummary(line) {
  if (line.channelMode !== 'set') return 'INHERIT';
  if (line.channels.length === 0) return 'NONE';
  const bySlot = new Map();
  for (const c of line.channels) {
    const slot = asSlot(c.out);
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(c.ch);
  }
  if (bySlot.size === 1) return `CH ${[...bySlot.values()][0].join(',')}`;
  return [...bySlot.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slot, chans]) => `${slot}:${chans.join(',')}`)
    .join(' ');
}

export function scaleSummary(patchOrLine) {
  const s = SCALES[patchOrLine.scale] ?? SCALES.major;
  return s.label;
}

/* ---------------------------------------------------------------- serialise */

export function serialize(patch) {
  return JSON.stringify(patch, null, 2);
}

/**
 * Parse and repair a patch. Anything unknown is dropped rather than trusted, so
 * a hand-edited or older file still opens, and a file claiming more nodes than
 * Gridi will hold is truncated rather than allowed to wedge the app.
 *
 * @param {string|object} text
 * @param {(kind: string, asked: number, kept: number) => void} [onLimit]
 */
export function deserialize(text, onLimit) {
  const raw = typeof text === 'string' ? JSON.parse(text) : text;
  const patch = createPatch(typeof raw.name === 'string' ? raw.name : 'Untitled');

  patch.bpm = clamp(Number(raw.bpm) || 112, 20, 300);
  patch.clockOut = raw.clockOut !== false;
  patch.root = clamp(Math.round(Number(raw.root) || 0), 0, 11);
  patch.scale = SCALES[raw.scale] ? raw.scale : 'minPent';
  patch.seed = Number(raw.seed) || 1;
  if (raw.view) {
    patch.view = {
      x: Number(raw.view.x) || 0,
      y: Number(raw.view.y) || 0,
      zoom: clamp(Number(raw.view.zoom) || 1, 0.3, 3),
    };
  }

  const allNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const nodes = allNodes.slice(0, LIMITS.nodes);
  if (allNodes.length > nodes.length) onLimit?.('nodes', allNodes.length, nodes.length);
  for (const n of nodes) {
    if (!n || !NODE_TYPES[n.type]) continue;
    const node = createNode(n.type, Number(n.col) || 0, Number(n.row) || 0);
    node.id = typeof n.id === 'string' && n.id ? n.id : node.id;
    node.label = typeof n.label === 'string' ? n.label : '';
    const defaults = defaultParams(n.type);
    const stored = n.params && typeof n.params === 'object' ? n.params : {};
    node.params = { ...defaults, ...stored };
    if (node.type === 'synth') migrateVoice(node.params, stored);
    if (node.type === 'pulse' && !DIVISIONS[node.params.division]) node.params.division = '1/16';
    // Drop anything the current schema no longer knows about, so migrated
    // params do not sit alongside the ones they replaced.
    for (const key of Object.keys(node.params)) {
      if (!(key in defaults)) delete node.params[key];
    }
    patch.nodes.push(node);
  }

  const ids = new Set(patch.nodes.map((n) => n.id));
  const allLines = Array.isArray(raw.lines) ? raw.lines : [];
  const lines = allLines.slice(0, LIMITS.lines);
  if (allLines.length > lines.length) onLimit?.('lines', allLines.length, lines.length);
  for (const l of lines) {
    if (!l || !ids.has(l.from) || !ids.has(l.to) || l.from === l.to) continue;
    const line = createLine(l.from, l.to);
    line.id = typeof l.id === 'string' && l.id ? l.id : line.id;
    line.channelMode = l.channelMode === 'set' ? 'set' : 'inherit';
    if (Array.isArray(l.channels) && l.channels.length) {
      line.channels = l.channels
        .filter((c) => c && Number.isFinite(Number(c.ch)))
        .map((c) => ({
          // Older patches predate output slots and belong on the first one.
          out: asSlot(c.out),
          ch: clamp(Math.round(Number(c.ch)), 1, 16),
          transpose: clamp(Math.round(Number(c.transpose) || 0), -48, 48),
          velocity: c.velocity == null ? null : clamp(Math.round(Number(c.velocity)), 1, 127),
        }));
      if (!line.channels.length) line.channels = [createChannel(1)];
    }
    line.scaleMode = l.scaleMode === 'set' ? 'set' : 'inherit';
    line.scale = SCALES[l.scale] ? l.scale : 'minPent';
    line.root = clamp(Math.round(Number(l.root) || 0), 0, 11);
    line.delay = clamp(Number(l.delay) || 0, 0, 16);
    line.muted = Boolean(l.muted);
    line.weight = clamp(Number(l.weight) || 1, 0, 8);
    patch.lines.push(line);
  }

  // Param targets that did not survive the import point at nothing.
  for (const n of patch.nodes) {
    if (n.type === 'param' && n.params.target && !ids.has(n.params.target)) {
      n.params.target = '';
      n.params.param = '';
    }
  }
  return patch;
}

export const clonePatch = (patch) => deepClone(patch);

/**
 * Voice nodes once had a single waveform shared by two oscillators detuned
 * symmetrically around it, and a filter sweep hard-coded at 3.5x the cutoff.
 * Carry those patches over so they still sound as they did.
 */
function migrateVoice(params, stored) {
  if (typeof stored.waveform !== 'string' || stored.aWave !== undefined) return;
  const wave = isWaveform(stored.waveform) ? stored.waveform : 'sawtooth';
  const detune = Math.abs(Number(stored.detune) || 0);
  Object.assign(params, {
    aWave: wave,
    bWave: wave,
    aOctave: 0,
    bOctave: 0,
    aSemi: 0,
    bSemi: 0,
    aDetune: -detune,
    bDetune: detune,
    aLevel: 1,
    bLevel: 1,
    filterEnv: Math.log2(3.5),
  });
}

/* -------------------------------------------------------------- demo patch */

/**
 * The patch the app opens with. It is a working instrument, not a screenshot:
 * clock -> live key change -> split -> bass voice, and a chance-gated router
 * scattering a melody across three notes on a second MIDI channel.
 */
export function demoPatch() {
  const p = createPatch('Tresillo Study');
  p.bpm = 104;
  p.root = 9; // A
  p.scale = 'minPent';

  const clock = addNode(p, createNode('pulse', 3, 14, {
    division: '1/16',
    swing: 0.18,
    euclidOn: true,
    euclidPulses: 5,
    euclidSteps: 16,
    velocity: 104,
  }));
  const split = addNode(p, createNode('split', 15, 14));
  const bass = addNode(p, createNode('synth', 27, 24, {
    degree: 1,
    octave: 1,
    aWave: 'sawtooth',
    aDetune: -6,
    aLevel: 0.75,
    bWave: 'square',
    bOctave: -1,
    bDetune: 6,
    bLevel: 0.5,
    cutoff: 900,
    resonance: 9,
    filterEnv: 2.2,
    decay: 0.22,
    sustain: 0.1,
    level: 0.4,
  }));
  const chance = addNode(p, createNode('chance', 27, 8, { probability: 72 }));
  const router = addNode(p, createNode('router', 39, 8, { mode: 'shuffle' }));
  const n1 = addNode(p, createNode('note', 51, 2, { degree: 1, octave: 4 }));
  const n2 = addNode(p, createNode('note', 51, 8, { degree: 3, octave: 4 }));
  const n3 = addNode(p, createNode('note', 51, 14, { degree: 5, octave: 3 }));

  const slow = addNode(p, createNode('pulse', 3, 28, {
    division: '1/1',
    ratioNum: 1,
    ratioDen: 2,
    velocity: 80,
  }));
  const key = addNode(p, createNode('key', 15, 28, {
    mode: 'cycle',
    steps: '9:minPent 2:minPent 4:minPent 7:mixolydian',
    latch: true,
  }));

  connect(p, clock.id, split.id);
  connect(p, split.id, bass.id);
  connect(p, split.id, chance.id, {
    channelMode: 'set',
    channels: [createChannel(2)],
  });
  connect(p, chance.id, router.id);
  connect(p, router.id, n1.id);
  connect(p, router.id, n2.id);
  connect(p, router.id, n3.id, { delay: 0.25 });
  connect(p, slow.id, key.id);

  return p;
}
