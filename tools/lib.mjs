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
export function modulate(patch, target, {
  param, from, to, rate = '4bar', shape = 'drift', phase = 0, resolution = 4, col = 0, row,
}) {
  const below = patch.nodes.length ? Math.max(...patch.nodes.map((n) => n.row)) + 8 : 0;
  const lfo = addNode(patch, createNode('lfo', col, row ?? below, {
    shape,
    rate,
    min: from,
    max: to,
    phase,
    resolution,
    reset: false, // free-running: it is a slow weather system, not a part
  }));
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

/** GM percussion, by the name this library calls it. */
export const KIT = {
  kick: 36, rim: 37, snare: 38, clap: 39, lowTom: 41, closedHat: 42,
  pedalHat: 44, openHat: 46, crash: 49, ride: 51, tambourine: 54,
  cowbell: 56, highAgogo: 67, lowAgogo: 68, shaker: 82,
};

/** What each channel of a patch should be playing, as General MIDI programs. */
export function sounds(patch, byChannel, out = 'A') {
  for (const [ch, program] of Object.entries(byChannel)) setSound(patch, out, Number(ch), program);
  return patch;
}

/** The General MIDI programs the library patches ask for, by name not number. */
export const GM = {
  rhodes: 4,
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
