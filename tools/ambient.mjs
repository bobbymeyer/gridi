// An ambient soundscape, after the tape loops on Music for Airports.
//
// Eno's trick was loops of different lengths running at once: the combination
// takes as long as their common multiple to come round, which for lengths that
// share no factors is longer than anyone listens. Here the lengths are
// polyrhythm ratios -- five, seven, eleven, thirteen and sixteen beats -- so the
// five voices come back into line once every 80080 beats, which at a beat a
// second is a little over twenty-two hours.

import { createPatch, createNode, addNode } from '../src/model.js';
import { downstream, channel, sounds, GM } from './lib.mjs';

/** Loop lengths in beats, and what each voice plays when its turn comes. */
const LOOPS = [
  { beats: 5, degree: 1, octave: 4, velocity: 54, probability: 100 },
  { beats: 7, degree: 4, octave: 4, velocity: 46, probability: 82 },
  { beats: 11, degree: 3, octave: 5, velocity: 42, probability: 74 },
  { beats: 13, degree: 2, octave: 5, velocity: 38, probability: 66 },
  { beats: 16, degree: 5, octave: 6, velocity: 34, probability: 58 },
];

export function ambientPatch() {
  const p = createPatch('Ambient');
  p.bpm = 60;
  p.grid = '1/4'; // a cell is a beat, so nothing is in a hurry
  p.root = 4; // E
  p.scale = 'majPent';

  LOOPS.forEach((loop, i) => {
    // A quarter-note division taken one in the time of `beats` gives a pulse
    // every `beats` beats, which is this voice's loop length.
    const clock = addNode(p, createNode('pulse', 0, i * 10, {
      division: '1/4',
      ratioNum: 1,
      ratioDen: loop.beats,
      velocity: loop.velocity,
    }));
    // A voice that always sounds has nothing to gate, and a Chance node set to
    // a hundred per cent is a node that does nothing. It gets the line direct.
    const source = loop.probability >= 100 ? clock : downstream(p, clock, {
      type: 'chance',
      cells: 2,
      params: { probability: loop.probability },
    }).node;
    downstream(p, source, {
      type: 'note',
      cells: 2,
      params: {
        degree: loop.degree,
        octave: loop.octave,
        length: 4, // four beats, so the voices overlap rather than answer
        audition: true,
      },
      line: channel(1),
    });
  });

  /* A slow sweep on the filter of whatever is receiving, so the texture moves
   * even in the stretches where no loop has come round. */
  const lfo = addNode(p, createNode('lfo', 0, LOOPS.length * 10, {
    shape: 'sine',
    rate: '8bar',
    depth: 0.8,
    min: 30,
    max: 96,
    resolution: 8,
  }));
  downstream(p, lfo, {
    type: 'param',
    cells: 4,
    params: { scope: 'midi', cc: 74 },
    line: channel(1),
  });

  return sounds(p, { 1: GM.warmPad });
}
