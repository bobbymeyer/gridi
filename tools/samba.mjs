// Samba: a bateria, a cavaquinho and a flute.
//
// The first version of this patch was a drum kit doing an impression of a
// bateria -- the surdo was a low tom, the tamborim a tambourine, and the only
// pitched thing in it was a bass playing two notes. General MIDI has a mute
// surdo and an open one, a cuíca, a cabasa and a pair of timbales sitting in
// the standard kit at their own note numbers, and samba has a cavaquinho in it.
// This one uses them.
//
// Everything is counted in sixteenths of a 4/4 bar, which is two bars of the
// 2/4 samba is actually written in: the surdo's open stroke on the "2" of each
// of those is the thing the rest of it leans against.

import { createPatch, createNode, addNode } from '../src/model.js';
import {
  downstream, figure, phase, channel, chord, drum, drumLine, KIT, modulate, sounds, GM,
} from './lib.mjs';

const BAR = 16; // cells in a 4/4 bar, at a sixteenth a cell
const HALF = 8; // and in one 2/4 samba bar, which is the unit nearly everything repeats on
const LAUNCH = 8; // where the bar line falls, once everything is in

/**
 * The caixa's accent, over one 2/4 bar of sixteenths.
 *
 * Three, three, two: the grouping that runs under most Brazilian rhythm. The
 * unaccented strokes are not silent, they are the hand staying down -- which is
 * why they are here as low velocities rather than as rests.
 */
const CAIXA = [96, 48, 54, 82, 46, 52, 78, 50];

/** Tamborim, the teleco-teco, in sixteenths across two 2/4 bars. */
const TAMBORIM = [0, 2, 3, 5, 9, 11, 12, 14];

/** Agogô, one 2/4 bar: high, low, high, low, with the pair pushed together. */
const AGOGO = [
  { offset: 0, note: KIT.highAgogo, velocity: 88 },
  { offset: 3, note: KIT.lowAgogo, velocity: 70 },
  { offset: 4, note: KIT.highAgogo, velocity: 80 },
  { offset: 6, note: KIT.lowAgogo, velocity: 66 },
];

export function sambaPatch() {
  const p = createPatch('Samba');
  p.bpm = 100;
  p.grid = '1/16';
  p.root = 9; // A
  p.scale = 'minor';

  /* Harmony: a bar each of i, iv, i, v, all minor sevenths, so one shape in the
   * cavaquinho's hand is the right chord in every bar. Latched, and a sixteenth
   * early, so the chord is in place before anything plays it. */
  const keyClock = addNode(p, createNode('pulse', 0, 0, { division: '1/1', velocity: 1 }));
  downstream(p, keyClock, {
    type: 'key',
    cells: LAUNCH - 1,
    params: { mode: 'cycle', steps: '9:minor 2:dorian 9:minor 4:minor', latch: true },
  });

  /* Surdo de marcação: the pulse of the whole thing. Muffled on the one of each
   * 2/4 bar, open and ringing on the two -- that open stroke is where samba
   * actually lands, and everything else is drawn against it. */
  const surdoClock = addNode(p, createNode('pulse', 0, 10, { division: '1/2' }));
  figure(p, surdoClock, [0, 4], (offset) => ({
    type: 'note',
    params: {
      ...drum(offset === 0 ? KIT.muteSurdo : KIT.openSurdo),
      velocity: offset === 0 ? 56 : 112,
      length: offset === 0 ? 0.2 : 0.7,
      audition: true,
    },
    line: drumLine(),
  }), { launch: LAUNCH, period: HALF, min: 4 });

  /* Caixa: sixteenths, the whole bar long, accented three-three-two by a Param
   * riding the pulse. The second Param jogs whatever the first decided by a few
   * either way, so the figure is stated and the hand still moves. */
  const caixaClock = addNode(p, createNode('pulse', 0, 22, { division: '1/16', velocity: 72 }));
  const caixaAccent = downstream(p, caixaClock, {
    type: 'param',
    cells: 4,
    params: { scope: 'signal', param: 'velocity', mode: 'sequence', values: CAIXA.join(' ') },
  }).node;
  const caixaHand = downstream(p, caixaAccent, {
    type: 'param',
    cells: 7,
    params: { scope: 'signal', param: 'velocity', mode: 'walk', amount: 6, min: 34, max: 120 },
  }).node;
  downstream(p, caixaHand, {
    type: 'note',
    // Eleven in all against an accent cycle of eight, so the figure comes round
    // where the bar does: 11 + 5 = 16.
    cells: 5,
    params: { ...drum(KIT.snare), length: 0.07, audition: true },
    line: drumLine(),
  });

  /* Ganzá, on the cabasa: sixteenths under everything, barely there, leaning on
   * the beat. What a bateria sounds like between the hits. */
  const ganzaClock = addNode(p, createNode('pulse', 0, 30, { division: '1/16', velocity: 40 }));
  const ganzaAccent = downstream(p, ganzaClock, {
    type: 'param',
    cells: 4,
    params: { scope: 'signal', param: 'velocity', mode: 'sequence', values: '48 28 34 30' },
  }).node;
  downstream(p, ganzaAccent, {
    type: 'note',
    cells: 4,
    params: { ...drum(KIT.cabasa), length: 0.05, audition: true },
    line: drumLine(),
  });

  /* Tamborim: the teleco-teco, on a high timbale because General MIDI has no
   * tamborim and a timbale is the nearest thing that is struck with a stick. */
  const tamClock = addNode(p, createNode('pulse', 0, 38, { division: '1/1', velocity: 84 }));
  figure(p, tamClock, TAMBORIM, () => ({
    type: 'note',
    params: { ...drum(KIT.hiTimbale), length: 0.06, audition: true },
    line: drumLine(),
  }), { launch: LAUNCH, period: BAR, min: 4 });

  /* Agogô: the two bells, one 2/4 bar of them, repeating. */
  const agogoClock = addNode(p, createNode('pulse', 0, 78, { division: '1/2', velocity: 80 }));
  figure(p, agogoClock, AGOGO.map((a) => a.offset), (offset) => {
    const bell = AGOGO.find((a) => a.offset === offset);
    return {
      type: 'note',
      params: { ...drum(bell.note), velocity: bell.velocity, length: 0.1, audition: true },
      line: drumLine(),
    };
  }, { launch: LAUNCH, period: HALF, min: 4 });

  /* Cuíca: the voice of the thing, and the one part that is not a pattern. It
   * speaks on about a third of the beats it could, and which of its two strokes
   * it uses is the Router's business. */
  const cuicaClock = addNode(p, createNode('pulse', 0, 98, { division: '1/4', velocity: 92 }));
  const cuicaGate = downstream(p, cuicaClock, {
    type: 'chance',
    cells: 4,
    params: { probability: 34, mode: 'drunk' },
  }).node;
  const cuicaPick = downstream(p, cuicaGate, {
    type: 'router',
    cells: 4,
    params: { mode: 'shuffle' },
  }).node;
  [[KIT.openCuica, 0], [KIT.muteCuica, 4]].forEach(([note, rowDelta]) => {
    downstream(p, cuicaPick, {
      type: 'note',
      cells: phase(LAUNCH, 2, 4, 16) - 8,
      rowDelta,
      params: { ...drum(note), length: 0.18, audition: true },
      line: drumLine(),
    });
  });

  /* Baixo: the root on the one of each 2/4 bar and the fifth a sixteenth before
   * the surdo opens, which is the push the whole bass part is made of. */
  const bassClock = addNode(p, createNode('pulse', 0, 110, { division: '1/2', velocity: 102 }));
  figure(p, bassClock, [0, 3], (offset) => ({
    type: 'note',
    params: {
      degree: offset === 0 ? 1 : 5,
      octave: 2,
      length: offset === 0 ? 0.35 : 0.2,
      audition: true,
    },
    line: channel(2),
  }), { launch: LAUNCH, period: HALF, min: 4 });

  /* Cavaquinho: a minor seventh chopped on the offbeats of each 2/4 bar. One
   * shape does for every bar because every chord in the cycle is a minor
   * seventh -- that is why the cycle was chosen. */
  const cavacoClock = addNode(p, createNode('pulse', 0, 124, { division: '1/2', velocity: 74 }));
  figure(p, cavacoClock, [3, 6], (offset) => ({
    type: 'note',
    params: { degree: 1, octave: 4, length: offset === 3 ? 0.18 : 0.12, audition: true },
    line: chord(3, [0, 3, 7, 10]),
  }), { launch: LAUNCH, period: HALF, min: 4 });

  /* Flute: choro's own instrument, sparse and syncopated over the top. Five
   * eighths in eight, thinned again by chance, and which degree it lands on is
   * shuffled -- so it is a line rather than a lick. */
  const fluteClock = addNode(p, createNode('pulse', 0, 138, {
    division: '1/8',
    euclidOn: true,
    euclidPulses: 5,
    euclidSteps: 8,
    velocity: 72,
  }));
  const fluteGate = downstream(p, fluteClock, {
    type: 'chance',
    cells: 6,
    params: { probability: 58 },
  }).node;
  const flutePick = downstream(p, fluteGate, {
    type: 'router',
    cells: 6,
    params: { mode: 'shuffle' },
  }).node;
  [1, 3, 5, 7].forEach((degree, i) => {
    downstream(p, flutePick, {
      type: 'note',
      cells: phase(LAUNCH, 0, 8, 28) - 12,
      rowDelta: i * 4,
      params: { degree, octave: 5, length: 0.3, audition: true },
      line: channel(4),
    });
  });

  /* A bateria is a room of people, and people lean. Each of these drifts one
   * player's velocity on a cycle of its own -- through a SoundFont that is the
   * tone of the hit as much as its weight -- so the room never plays a bar the
   * same way twice. The caixa's is on its hand rather than its arm: how far off
   * the grid it puts the stroke. */
  modulate(p, surdoClock, { param: 'velocity', from: 84, to: 122, rate: '4bar' });
  modulate(p, tamClock, { param: 'velocity', from: 56, to: 100, rate: '2bar' });
  modulate(p, agogoClock, { param: 'velocity', from: 58, to: 100, rate: '4bar', phase: 0.37 });
  modulate(p, ganzaClock, { param: 'velocity', from: 28, to: 56, rate: '2bar', phase: 0.6 });
  modulate(p, cuicaClock, { param: 'velocity', from: 60, to: 104, rate: '4bar', phase: 0.15 });
  modulate(p, bassClock, { param: 'velocity', from: 84, to: 116, rate: '4bar', phase: 0.65 });
  modulate(p, cavacoClock, { param: 'velocity', from: 54, to: 98, rate: '2bar', phase: 0.25 });
  modulate(p, fluteClock, { param: 'velocity', from: 48, to: 96, rate: '1bar' });
  modulate(p, caixaClock, { param: 'humanize', from: 0, to: 9, rate: '8bar', phase: 0.2 });
  // And how much the cuíca has to say this time round.
  modulate(p, cuicaGate, { param: 'probability', from: 18, to: 52, rate: '8bar', phase: 0.5 });

  return sounds(p, {
    2: GM.acousticBass,
    3: GM.banjo,
    4: GM.flute,
    10: GM.standardKit,
  });
}
