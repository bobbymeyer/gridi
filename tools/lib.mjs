// Placement helpers for the library patches.
//
// Distance is time, so building a patch means solving for positions: a branch
// that has to arrive N sixteenths late has to be drawn N cells of line away.
// These turn a musical offset into a column and a row.

import { createNode, addNode, connect, createChannel } from '../src/model.js';
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
