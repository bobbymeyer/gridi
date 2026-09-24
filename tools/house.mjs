// House: four to the floor, and everything else drawn against it.
//
// The open hat is the clearest thing in the library: the same quarter-note
// clock as the kick, its line two cells longer, which is an eighth. The offbeat
// is not a setting here, it is a distance.

import { createPatch, createNode, addNode } from '../src/model.js';
import { downstream, phase, channel, chord, drum, drumLine, KIT, modulate, sounds, GM } from './lib.mjs';

const BEAT = 4; // cells
const BAR = 16;
const LAUNCH = 4;

export function housePatch() {
  const p = createPatch('House');
  p.bpm = 124;
  p.grid = '1/16';
  p.root = 0; // C
  p.scale = 'minor';

  const voice = (row, pulse, { offset, period, min = 1, params, line }) => {
    const clock = addNode(p, createNode('pulse', 0, row, pulse));
    const built = downstream(p, clock, {
      type: 'note',
      cells: phase(LAUNCH, offset, period, min),
      params,
      line,
    });
    return { clock, ...built };
  };

  /* Kick, on every beat. */
  voice(0, { division: '1/4', velocity: 112 }, {
    offset: 0,
    period: BEAT,
    params: { ...drum(KIT.kick), length: 0.2, audition: true },
    line: drumLine(),
  });

  /* Open hat, an eighth later off the same beat. */
  const openHat = voice(6, { division: '1/4', velocity: 84 }, {
    offset: 2,
    period: BEAT,
    params: { ...drum(KIT.openHat), length: 0.18, audition: true },
    line: drumLine(),
  });

  /* Clap, on two and four. */
  voice(12, { division: '1/2', velocity: 102 }, {
    offset: BEAT,
    period: BEAT * 2,
    params: { ...drum(KIT.clap), length: 0.12, audition: true },
    line: drumLine(),
  });

  /* Closed hats, under everything. */
  const closedHat = voice(18, { division: '1/16', velocity: 52 }, {
    offset: 0,
    period: 1,
    min: 4,
    params: { ...drum(KIT.closedHat), length: 0.05, audition: true },
    line: drumLine(),
  });

  /* Bass: offbeat, with the same clock as the open hat and the same distance,
   * so the two of them lock. Which note it plays is the Router's business. */
  const bassClock = addNode(p, createNode('pulse', 0, 24, { division: '1/4', velocity: 106 }));
  const bassPick = downstream(p, bassClock, {
    type: 'router',
    cells: 6,
    params: { mode: 'shuffle' },
  }).node;
  [1, 1, 5, 4].forEach((degree, i) => {
    downstream(p, bassPick, {
      type: 'note',
      cells: phase(LAUNCH, 2, BEAT, 20) - 6,
      rowDelta: i * 4,
      params: { degree, octave: 2, length: 0.2, audition: true },
      line: channel(2),
    });
  });

  /* Stab: a minor triad on the push, when the Chance lets it through. */
  const stabClock = addNode(p, createNode('pulse', 0, 44, { division: '1/2', velocity: 76 }));
  const stabGate = downstream(p, stabClock, {
    type: 'chance',
    cells: 2,
    params: { probability: 55 },
  }).node;
  downstream(p, stabGate, {
    type: 'note',
    cells: phase(LAUNCH, 6, BAR / 2, 10) - 2,
    params: { degree: 1, octave: 4, length: 0.22, audition: true },
    line: chord(3, [0, 3, 7, 10]),
  });

  /* Four to the floor is a loop on purpose, so what moves is the playing
   * rather than the pattern: hats that open and close over a couple of bars, a
   * bass that leans harder some bars than others, and a stab that comes and
   * goes. Velocity is tone as well as level through a SoundFont, so a hat at a
   * hundred and a hat at sixty are two different hats. */
  modulate(p, closedHat.clock, { param: 'velocity', from: 34, to: 86, rate: '1bar' });
  modulate(p, openHat.clock, { param: 'velocity', from: 58, to: 106, rate: '2bar' });
  modulate(p, bassClock, { param: 'velocity', from: 84, to: 120, rate: '4bar' });
  modulate(p, stabClock, { param: 'velocity', from: 52, to: 104, rate: '2bar', phase: 0.4 });
  modulate(p, stabGate, { param: 'probability', from: 28, to: 82, rate: '8bar' });

  return sounds(p, { 2: GM.synthBass, 3: GM.rhodes, 10: GM.electronicKit });
}
