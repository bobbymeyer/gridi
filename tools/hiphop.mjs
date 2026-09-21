// Hip-hop: a boom-bap kit, swung hats, and a bass that stays out of the way.
//
// The kick figure is one clock and one Split, its three hits drawn at the
// offsets they fall on. Everything else runs off its own clock, short, so the
// beat is up within a bar.

import { createPatch, createNode, addNode } from '../src/model.js';
import { downstream, fan, phase, channel, drum, drumLine, KIT, sounds, GM } from './lib.mjs';

const BEAT = 4; // cells
const BAR = 16;
const LAUNCH = 5;

/** The kick, in sixteenths from the downbeat: one, the a of two, the and of three. */
const KICKS = [0, 7, 10];

export function hiphopPatch() {
  const p = createPatch('Hip-Hop');
  p.bpm = 88;
  p.grid = '1/16';
  p.root = 9; // A
  p.scale = 'minPent';

  /* Kick figure: one clock a bar, three hits at their own distances. */
  const kickClock = addNode(p, createNode('pulse', 0, 0, { division: '1/1', velocity: 116 }));
  const kickFan = downstream(p, kickClock, { type: 'split', cells: 1 }).node;
  fan(p, kickFan, KICKS, (offset) => ({
    type: 'note',
    params: { ...drum(KIT.kick), velocity: offset === 0 ? 118 : 96, length: 0.18, audition: true },
    line: drumLine(),
  }));

  /* Snare, on two and four, and nowhere else. */
  const snareClock = addNode(p, createNode('pulse', 0, 16, { division: '1/2', velocity: 110 }));
  downstream(p, snareClock, {
    type: 'note',
    cells: phase(LAUNCH, BEAT, BEAT * 2),
    params: { ...drum(KIT.snare), length: 0.14, audition: true },
    line: drumLine(),
  });

  /* Hats on the eighth, swung: the shuffle the whole thing leans on. */
  const hatClock = addNode(p, createNode('pulse', 0, 22, {
    division: '1/8',
    swing: 0.22,
    velocity: 72,
  }));
  downstream(p, hatClock, {
    type: 'note',
    cells: phase(LAUNCH, 0, 2),
    params: { ...drum(KIT.closedHat), length: 0.05, audition: true },
    line: drumLine(),
  });

  /* And a sixteenth that shows up about a fifth of the time, under the rest. */
  const ghostClock = addNode(p, createNode('pulse', 0, 28, { division: '1/16', velocity: 40 }));
  const ghostGate = downstream(p, ghostClock, {
    type: 'chance',
    cells: 1,
    params: { probability: 22 },
  }).node;
  downstream(p, ghostGate, {
    type: 'note',
    cells: 1,
    params: { ...drum(KIT.closedHat), length: 0.04, audition: true },
    line: drumLine(),
  });

  /* Bass: half notes, three degrees of A minor pentatonic, shuffled. */
  const bassClock = addNode(p, createNode('pulse', 0, 34, { division: '1/2', velocity: 104 }));
  const bassPick = downstream(p, bassClock, {
    type: 'router',
    cells: 5,
    params: { mode: 'shuffle' },
  }).node;
  [1, 1, 4].forEach((degree, i) => {
    downstream(p, bassPick, {
      type: 'note',
      cells: phase(LAUNCH, 0, BEAT * 2, 18) - 5,
      rowDelta: i * 4,
      params: { degree, octave: 2, length: 0.7, audition: true },
      line: channel(2),
    });
  });

  /* A figure on top: three of every eight eighths, and then only sometimes. */
  const topClock = addNode(p, createNode('pulse', 0, 50, {
    division: '1/8',
    euclidOn: true,
    euclidPulses: 3,
    euclidSteps: 8,
    swing: 0.22,
    velocity: 66,
  }));
  const topGate = downstream(p, topClock, {
    type: 'chance',
    cells: 2,
    params: { probability: 55 },
  }).node;
  const topPick = downstream(p, topGate, {
    type: 'router',
    cells: 3,
    params: { mode: 'shuffle' },
  }).node;
  [1, 3, 4, 5].forEach((degree, i) => {
    downstream(p, topPick, {
      type: 'note',
      cells: phase(LAUNCH, 0, BAR, 21) - 5,
      rowDelta: i * 4,
      params: { degree, octave: 5, length: 0.3, audition: true },
      line: channel(4),
    });
  });

  return sounds(p, { 2: GM.fingeredBass, 4: GM.vibraphone, 10: GM.standardKit });
}
