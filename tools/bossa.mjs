// The bossa nova generator, built rather than drawn.
//
// The clave is the reason this is a script. Its five hits are 0, 6, 12, 20 and
// 28 sixteenths apart, and on this instrument an offset is a distance, so each
// hit is a line of that many cells. Solving five of those by hand, and then
// keeping the bass and the melody in phase with them, is arithmetic; a script
// does arithmetic without making mistakes.
//
// Every part is late by its own chain, so the phases only line up if each
// chain's total length agrees with the others modulo that part's own cycle.
// LAUNCH is the offset they all agree on; the rest is the smallest multiple of
// a part's cycle that leaves room to draw it.

import { createPatch, createNode, addNode, serialize } from '../src/model.js';
import { downstream, channel } from './lib.mjs';

const BAR = 16; // cells, at a sixteenth a cell

/** Bossa clave, 3-2, in sixteenths from the first hit. Three in one bar, two in the next. */
const CLAVE = [0, 6, 12, 20, 28];

/** Where the first clave hit lands, and what every other part lines up with. */
const LAUNCH = 8;

export function bossaPatch() {
  const p = createPatch('Bossa Nova');
  p.bpm = 132;
  p.grid = '1/16';
  p.root = 0; // C, though the Key node has the last word from the downbeat on
  p.scale = 'major';

  /* Harmony: one bar each of ii - V - I - I, latched so the whole patch turns
   * with it. It lands a sixteenth before the comp so the chord is already in
   * place when the bar's first chord tone fires. */
  const harmonyClock = addNode(p, createNode('pulse', 0, 40, {
    division: '1/1',
    velocity: 1, // it triggers a key change, not a note
  }));
  downstream(p, harmonyClock, {
    type: 'key',
    cells: LAUNCH - 1,
    params: {
      mode: 'cycle',
      steps: '2:dorian 7:mixolydian 0:major 0:major',
      latch: true,
    },
  });

  /* Comping: a broken seventh chord spread across the clave. Each hit is its
   * own line, and the line's length is the hit's place in the bar. */
  const compClock = addNode(p, createNode('pulse', 0, 0, {
    division: '1/1',
    ratioNum: 1,
    ratioDen: 2, // one turn of the clave is two bars
    velocity: 78,
  }));
  const comp = downstream(p, compClock, { type: 'split', cells: 4 }).node;
  const VOICING = [1, 7, 3, 5, 7]; // root, seventh, third, fifth, seventh
  CLAVE.forEach((offset, i) => {
    downstream(p, comp, {
      type: 'note',
      cells: 4 + offset,
      rowDelta: i * 5,
      params: { degree: VOICING[i], octave: 4, length: 0.45, audition: true },
      line: channel(3),
    });
  });

  /* Bass: root and fifth, one to the half note, the two-feel a bossa walks on.
   * Both branches are the same length, so the Router alone decides which of
   * them speaks -- the distance is carrying no rhythm here. */
  const bassClock = addNode(p, createNode('pulse', 0, 28, {
    division: '1/2',
    velocity: 96,
  }));
  const bassPick = downstream(p, bassClock, {
    type: 'router',
    cells: 8,
    params: { mode: 'cycle' },
  }).node;
  [[1, 0], [5, 5]].forEach(([degree, rowDelta]) => {
    downstream(p, bassPick, {
      type: 'note',
      // Sixteen, which with the Router's eight puts the bass at LAUNCH plus a
      // bar: the smallest delay that still leaves room to draw the lower branch.
      cells: LAUNCH + BAR - 8,
      rowDelta,
      params: { degree, octave: 2, length: 0.9, audition: true },
      line: channel(2),
    });
  });

  /* Melody: five hits spread over sixteen eighths, thinned again by chance, so
   * the top line is sparse and never quite the same bar twice. */
  const topClock = addNode(p, createNode('pulse', 0, 56, {
    division: '1/8',
    euclidOn: true,
    euclidPulses: 5,
    euclidSteps: 16,
    velocity: 70,
  }));
  const topChance = downstream(p, topClock, {
    type: 'chance',
    cells: 8,
    params: { probability: 62 },
  }).node;
  const topPick = downstream(p, topChance, {
    type: 'router',
    cells: 8,
    params: { mode: 'shuffle' },
  }).node;
  [1, 2, 3, 5].forEach((degree, i) => {
    downstream(p, topPick, {
      type: 'note',
      // With the eight to the Chance and the eight to the Router, the melody
      // is forty cells late: LAUNCH plus two bars, which is its Euclid cycle.
      cells: 24,
      rowDelta: i * 5,
      params: { degree, octave: 5, length: 0.35, audition: true },
      line: channel(4),
    });
  });

  return p;
}

if (process.argv[1]?.endsWith('bossa.mjs')) {
  process.stdout.write(serialize(bossaPatch()));
}
