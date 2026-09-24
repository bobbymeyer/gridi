// Placement helpers for the library patches.
//
// Distance is time, so building a patch means solving for positions: a branch
// that has to arrive N sixteenths late has to be drawn N cells of line away.
// These turn a musical offset into a column and a row.

import { createNode, addNode, connect, createChannel, setSound } from '../src/model.js';
import { lineCells } from '../src/geometry.js';

export const NODE_W = 6; // cells; a node is this wide, and the line starts at its right edge

/**
 * Where to put a node so the line feeding it is exactly `cells` long.
 *
 * A forward route runs out of the source's right edge, doglegs once, and comes
 * in at the target's left edge, so its length is the horizontal run plus the
 * vertical one. Inverting that gives the column. The dogleg needs three clear
 * cells to turn in, which is why a row change costs a minimum.
 */
export function columnFor(source, cells, rowDelta) {
  const col = source.col + NODE_W + cells - Math.abs(rowDelta);
  const min = source.col + (rowDelta === 0 ? 7 : 10);
  if (col < min) {
    throw new Error(
      `cannot draw ${cells} cells with a ${rowDelta}-row drop: `
      + `the turn alone costs ${min - source.col - NODE_W + Math.abs(rowDelta)}`,
    );
  }
  return col;
}

/** Add a node `cells` of line downstream of `source`, and patch them together. */
export function downstream(patch, source, { type, cells, rowDelta = 0, params = {}, line = {} }) {
  const node = addNode(patch, createNode(
    type,
    columnFor(source, cells, rowDelta),
    source.row + rowDelta,
    params,
  ));
  const wire = connect(patch, source.id, node.id, line);
  const got = lineCells(source, node);
  if (got !== cells) throw new Error(`asked for ${cells} cells, drew ${got}`);
  return { node, line: wire };
}

/**
 * A drifting LFO wired to one parameter of one node.
 *
 * Velocity is the modulation a SoundFont hears. The bundled font routes it to
 * loudness and to filter cutoff both, so a moving velocity is a moving tone and
 * not merely a moving level — and a part played at one velocity for ever is one
 * sound for ever, however much its rhythm moves. A CC sweep, by contrast, goes
 * out of the MIDI port and straight past the internal player, which is why
 * these patches could have plenty moving on the wire and still sound the same
 * every bar.
 *
 * `drift` is the shape because it does not come round: it eases between hashed
 * values, so the twentieth bar is not the fourth and none of it is random in
 * the sense of being different every time you press play.
 *
 * The modulator hangs off the side of the patch. It is wired to nothing in the
 * sounding chain, so it cannot change anybody's timing — which is the whole
 * reason the phases in these files still add up.
 */
/** An LFO, or the Param node one drives: the weather, not the music. */
const isModulator = (node) =>
  node.type === 'lfo' || (node.type === 'param' && node.params.scope === 'node');

export function modulate(patch, target, {
  param, from, to, rate = '4bar', shape = 'drift', phase = 0, resolution = 4, col, row,
}) {
  // A rack down the side of the patch rather than a tail underneath it: ten
  // modulators stacked below a bateria make the whole thing twice as tall as it
  // is wide, and a fit then draws the music at half the size to make room for
  // the weather.
  const own = patch.nodes.filter((n) => !isModulator(n));
  const rack = patch.nodes.filter((n) => n.type === 'lfo').length;
  const lfo = addNode(patch, createNode(
    'lfo',
    col ?? (own.length ? Math.max(...own.map((n) => n.col)) + 14 : 0),
    row ?? rack * 8,
    {
      shape,
      rate,
      min: from,
      max: to,
      phase,
      resolution,
      reset: false, // free-running: it is a slow weather system, not a part
    },
  ));

  const { node } = downstream(patch, lfo, {
    type: 'param',
    cells: 7,
    params: { scope: 'node', target: target.id, param, mode: 'sequence', min: 0, max: 127 },
  });
  return { lfo, param: node };
}

/** A line that sends to one MIDI channel. */
export function channel(ch, transpose = 0) {
  return { channelMode: 'set', channels: [{ ...createChannel(ch, 'A'), transpose }] };
}

/** A line that sounds several pitches at once on one channel: a chord. */
export function chord(ch, transposes) {
  return {
    channelMode: 'set',
    channels: transposes.map((t) => ({ ...createChannel(ch, 'A'), transpose: t })),
  };
}

/**
 * A row of branches off one node, each arriving at its own offset.
 *
 * The offsets are what you want to hear -- a rhythm, in cells from the first
 * hit. The rest is what the drawing costs: a branch that drops rows has to
 * spend cells on the drop before it can spend any on being late, so the whole
 * figure is pushed out until the steepest branch fits. `base` is how far it
 * had to move, which is what another part has to match to stay in phase.
 *
 * @returns {{nodes: object[], base: number, span: number}}
 */
export function fan(patch, source, offsets, build, { rowStep = 4 } = {}) {
  const sorted = [...offsets].sort((a, b) => a - b);
  let base = 1;
  for (let i = 0; i < sorted.length; i += 1) {
    const need = i * rowStep + 4 - (sorted[i] - sorted[0]);
    if (need > base) base = need;
  }
  const nodes = sorted.map((offset, i) => downstream(patch, source, {
    ...build(offset, i),
    cells: base + offset - sorted[0],
    rowDelta: i * rowStep,
  }).node);
  return { nodes, base, span: base + sorted[sorted.length - 1] - sorted[0] };
}

/**
 * How far `fan` has to push a figure out before its steepest branch fits.
 *
 * Pulled out of `fan` so a caller can solve for the distance that puts the
 * whole figure where it belongs in the bar, which needs the base before any of
 * it is drawn.
 */
export function fanBase(offsets, rowStep = 4) {
  const sorted = [...offsets].sort((a, b) => a - b);
  let base = 1;
  for (let i = 0; i < sorted.length; i += 1) {
    const need = i * rowStep + 4 - (sorted[i] - sorted[0]);
    if (need > base) base = need;
  }
  return base;
}

/**
 * A figure, in the right place in the bar.
 *
 * `fan` draws a rhythm relative to its own first hit; this puts that first hit
 * where the bar wants it. The split it fans from is drawn at whatever distance
 * makes the arithmetic come out — the figure's own push, plus however many
 * whole cycles it takes before there is room to draw it.
 */
export function figure(patch, clock, offsets, build, {
  launch = 0, period = 16, rowStep = 4, min = 1, split = {},
} = {}) {
  // `fan` draws its offsets relative to its own first hit, so the split has to
  // carry where that first hit belongs: without the `+ first` the whole figure
  // slides onto the downbeat, which for anything written off the beat -- a
  // cavaquinho's chop, say -- is precisely the wrong place.
  const base = fanBase(offsets, rowStep);
  const first = Math.min(...offsets);
  const hub = downstream(patch, clock, {
    type: 'split',
    cells: phase(launch + first - base, 0, period, min),
    ...split,
  }).node;
  return { hub, ...fan(patch, hub, offsets, build, { rowStep }) };
}

/**
 * The shortest chain length that puts a voice where it belongs in the bar.
 *
 * A voice repeats every `period` cells, so being late by a whole number of
 * periods costs nothing but a later entry on the first pass. `launch` is the
 * offset every part in the patch shares, `offset` is where this voice sits
 * against the bar, and `min` is how short the drawing will allow.
 */
export function phase(launch, offset, period, min = 1) {
  let cells = ((launch + offset) % period + period) % period;
  while (cells < min) cells += period;
  return cells;
}

/** GM drum note -> the degree and octave that name it on a chromatic line. */
export function drum(note) {
  return { degree: (note % 12) + 1, octave: Math.floor(note / 12) - 1 };
}

/** A line pinned to the drum channel and to real note numbers, whatever the key does. */
export function drumLine(ch = 10) {
  return { ...channel(ch), scaleMode: 'set', scale: 'chromatic', root: 0 };
}

/**
 * GM percussion, by the name this library calls it.
 *
 * The second row is the part of the General MIDI kit nobody reaches for: a
 * surdo, a cuíca, a cabasa and a pair of timbales are all in the standard kit
 * at their own note numbers, and a samba played on a tom and a tambourine
 * instead is a drum kit doing an impression of a bateria.
 */
export const KIT = {
  kick: 36, rim: 37, snare: 38, clap: 39, lowTom: 41, closedHat: 42,
  pedalHat: 44, openHat: 46, crash: 49, ride: 51, tambourine: 54,
  cowbell: 56, highAgogo: 67, lowAgogo: 68, shaker: 82,

  hiBongo: 60, loBongo: 61, muteConga: 62, openConga: 63, loConga: 64,
  hiTimbale: 65, loTimbale: 66, cabasa: 69, maracas: 70, shortWhistle: 71,
  claves: 75, hiWoodBlock: 76, muteCuica: 78, openCuica: 79,
  muteTriangle: 80, openTriangle: 81, muteSurdo: 86, openSurdo: 87,
};

/** What each channel of a patch should be playing, as General MIDI programs. */
export function sounds(patch, byChannel, out = 'A') {
  for (const [ch, program] of Object.entries(byChannel)) setSound(patch, out, Number(ch), program);
  return patch;
}

/** The General MIDI programs the library patches ask for, by name not number. */
export const GM = {
  rhodes: 4,
  banjo: 105, // the cavaquinho's nearest neighbour in General MIDI
  trumpet: 56,
  vibraphone: 11,
  nylonGuitar: 24,
  jazzGuitar: 26,
  acousticBass: 32,
  fingeredBass: 33,
  synthBass: 38,
  strings: 48,
  flute: 73,
  sawLead: 81,
  warmPad: 89,
  standardKit: 0,
  electronicKit: 24,
};
