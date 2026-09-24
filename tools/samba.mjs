// Samba: percussion, and a bass that follows the surdo.
//
// Each voice runs off its own clock, and where it sits in the bar is how far
// its line runs. The surdo is a half-note pulse drawn a beat further out than
// the caixa, which is the whole of why it lands on two and four.

import { createPatch, createNode, addNode } from '../src/model.js';
import { downstream, fan, phase, channel, drum, drumLine, KIT, modulate, sounds, GM } from './lib.mjs';

const BAR = 16; // cells, at a sixteenth a cell
const LAUNCH = 8; // where the bar line falls, once everything is in

/**
 * Tamborim, in sixteenths from the downbeat. A sixteenth-note figure with the
 * push onto the second half of the bar that gives samba its lean.
 */
const TAMBORIM = [0, 3, 6, 10, 12, 14];

export function sambaPatch() {
  const p = createPatch('Samba');
  p.bpm = 96;
  p.grid = '1/16';
  p.root = 9; // A
  p.scale = 'minPent';

  /* Caixa: every sixteenth, accented in fours by a Param riding the pulse. */
  const caixaClock = addNode(p, createNode('pulse', 0, 0, {
    division: '1/16',
    velocity: 80,
  }));
  const accent = downstream(p, caixaClock, {
    type: 'param',
    cells: 4,
    // Seven accents against a bar of sixteen: the figure walks around the bar
    // and comes back to where it started seven bars later, which is a samba
    // caixa and not a drum machine.
    params: { scope: 'signal', param: 'velocity', mode: 'sequence', values: '106 64 80 62 92 68 74' },
  }).node;
  downstream(p, accent, {
    type: 'note',
    cells: 4, // eight in all, and the accent cycle is four, so it lands on the beat
    params: { ...drum(KIT.snare), length: 0.08, audition: true },
    line: drumLine(),
  });

  /* Surdo: a beat later than everything else, which puts it on two and four,
   * and alternating a ghost with an open stroke. */
  const surdoClock = addNode(p, createNode('pulse', 0, 12, { division: '1/2' }));
  const surdoPick = downstream(p, surdoClock, {
    type: 'router',
    cells: 4,
    params: { mode: 'cycle' },
  }).node;
  [[55, 0], [112, 4]].forEach(([velocity, rowDelta]) => {
    downstream(p, surdoPick, {
      type: 'note',
      cells: phase(LAUNCH, 4, BAR * 2, 8) - 4, // the router already spent four
      rowDelta,
      params: { ...drum(KIT.lowTom), velocity, length: 0.5, audition: true },
      line: drumLine(),
    });
  });

  /* Tamborim: one figure a bar, its six hits drawn at their own offsets. */
  const tamClock = addNode(p, createNode('pulse', 0, 26, { division: '1/1', velocity: 88 }));
  const tamFan = downstream(p, tamClock, { type: 'split', cells: 14 }).node;
  fan(p, tamFan, TAMBORIM, () => ({
    type: 'note',
    params: { ...drum(KIT.tambourine), length: 0.08, audition: true },
    line: drumLine(),
  }));

  /* Agogô: two bells, thinned to five of every eight eighths. */
  const agogoClock = addNode(p, createNode('pulse', 0, 58, {
    division: '1/8',
    euclidOn: true,
    euclidPulses: 5,
    euclidSteps: 8,
    velocity: 74,
  }));
  const agogoPick = downstream(p, agogoClock, {
    type: 'router',
    cells: 8,
    params: { mode: 'cycle' },
  }).node;
  [[KIT.highAgogo, 0], [KIT.lowAgogo, 4]].forEach(([note, rowDelta]) => {
    downstream(p, agogoPick, {
      type: 'note',
      cells: BAR, // with the router's eight, a bar and a half out and in phase
      rowDelta,
      params: { ...drum(note), length: 0.12, audition: true },
      line: drumLine(),
    });
  });

  /* Bass: on the surdo, in A minor pentatonic, picked from three degrees. */
  const bassClock = addNode(p, createNode('pulse', 0, 72, { division: '1/2', velocity: 100 }));
  const bassPick = downstream(p, bassClock, {
    type: 'router',
    cells: 4,
    params: { mode: 'shuffle' },
  }).node;
  [1, 1, 4].forEach((degree, i) => {
    downstream(p, bassPick, {
      type: 'note',
      // Three branches stacked means twelve cells of turning before any of
      // them can be late, so the whole part waits a bar longer than it has to.
      cells: phase(LAUNCH, 4, BAR, 16) - 4,
      rowDelta: i * 4,
      params: { degree, octave: 2, length: 0.4, audition: true },
      line: channel(2),
    });
  });

  /* A samba bateria is a room of people, and people lean. Each of these drifts
   * one player's velocity on its own cycle — which through a SoundFont moves
   * the tone of the hit as well as its weight — so no two bars are struck the
   * same way even where the pattern repeats exactly. */
  modulate(p, surdoClock, { param: 'velocity', from: 74, to: 120, rate: '4bar' });
  modulate(p, tamClock, { param: 'velocity', from: 58, to: 110, rate: '2bar' });
  modulate(p, agogoClock, { param: 'velocity', from: 56, to: 104, rate: '4bar', phase: 0.37 });
  modulate(p, bassClock, { param: 'velocity', from: 78, to: 116, rate: '4bar', phase: 0.65 });
  // And the caixa's own hand: how far off the grid it plays, which is the
  // difference between a machine and somebody's wrist.
  modulate(p, caixaClock, { param: 'humanize', from: 0, to: 11, rate: '8bar', phase: 0.2 });

  return sounds(p, { 2: GM.acousticBass, 10: GM.standardKit });
}
