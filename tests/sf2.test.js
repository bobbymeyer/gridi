// Reading a SoundFont: the chunks, and the zone model on top of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSf2, voicesFor, presetFor, realPresets, GEN, DEFAULTS,
  timecentsToSeconds, centibelsToGain, centsToHz,
  readSource, shape, modulatorValue, stackModulators, applyModulators,
  DEFAULT_MODULATORS, SOURCE,
} from '../src/sf2.js';
import { buildSf2, gen } from './sf2-fixture.js';

/** A font with one sample, a split instrument and one preset over it. */
function testFont(overrides = {}) {
  return parseSf2(buildSf2({
    name: 'Gridi Test',
    pcm: Array.from({ length: 100 }, (_, i) => Math.round(Math.sin(i / 4) * 30000)),
    sample: { rootKey: 60, sampleRate: 22050, loopStart: 10, loopEnd: 90 },
    instrumentZones: [
      // Global: everything below gets this pan unless it says otherwise.
      [gen(GEN.pan, 100)],
      // Low half, quiet and slow to speak.
      [
        gen(GEN.keyRange, { lo: 0, hi: 59 }),
        gen(GEN.attackVolEnv, -3000),
        gen(GEN.initialAttenuation, 60),
        gen(GEN.sampleID, 0),
      ],
      // High half, and it loops.
      [
        gen(GEN.keyRange, { lo: 60, hi: 127 }),
        gen(GEN.attackVolEnv, -1200),
        gen(GEN.sampleModes, 1),
        gen(GEN.sampleID, 0),
      ],
    ],
    presetZones: [[gen(GEN.coarseTune, 2), gen(GEN.instrument, 0)]],
    bank: 0,
    program: 5,
    ...overrides,
  }));
}

/* ------------------------------------------------------------- the chunks */

test('a SoundFont reads back the name and the sample it was built with', () => {
  const font = testFont();
  assert.equal(font.name, 'Gridi Test');
  assert.equal(font.samples.length, 100);
  assert.equal(font.headers[0].name, 'sample');
  assert.equal(font.headers[0].sampleRate, 22050);
  assert.equal(font.headers[0].rootKey, 60);
  assert.deepEqual([font.headers[0].loopStart, font.headers[0].loopEnd], [10, 90]);
});

test('the terminal record of a table is arithmetic, not a preset', () => {
  const font = testFont();
  assert.equal(font.presets.length, 2, 'the table keeps its sentinel');
  assert.deepEqual(realPresets(font).map((p) => p.name), ['Test Preset']);
  assert.equal(realPresets(font)[0].program, 5);
  assert.equal(realPresets(font)[0].bank, 0);
});

test('anything that is not a SoundFont is refused, not half read', () => {
  for (const bytes of [new ArrayBuffer(0), new ArrayBuffer(200), new TextEncoder().encode('RIFF not really').buffer]) {
    assert.throws(() => parseSf2(bytes), /not a SoundFont|no p/);
  }
});

test('a SoundFont missing the tables it needs says which', () => {
  const whole = new Uint8Array(buildSf2({ pcm: [0, 1] }));
  const broken = new Uint8Array(whole);
  // Rename the instrument table, so the file is a SoundFont with a hole in it.
  const at = broken.findIndex((_, i) => String.fromCharCode(...broken.slice(i, i + 4)) === 'inst');
  assert.ok(at > 0, 'the fixture has an inst chunk to break');
  broken.set([0x78, 0x78, 0x78, 0x78], at);
  assert.throws(() => parseSf2(broken.buffer), /no inst/);
});

/* -------------------------------------------------------------- the zones */

// Full velocity, where both default modulators contribute exactly zero, so a
// generator's value is the generator's value. Anything softer is the sum of
// the zone and the font's own velocity routings, which is its own section.
const LOUD = 127;

test('a key picks the zone whose range covers it', () => {
  const font = testFont();
  const preset = realPresets(font)[0];

  const low = voicesFor(font, preset, 40, LOUD);
  assert.equal(low.length, 1);
  assert.equal(low[0].gens[GEN.attackVolEnv], -3000);
  assert.equal(low[0].gens[GEN.initialAttenuation], 60);

  const high = voicesFor(font, preset, 72, LOUD);
  assert.equal(high.length, 1);
  assert.equal(high[0].gens[GEN.attackVolEnv], -1200);
  assert.equal(high[0].gens[GEN.sampleModes], 1, 'and this one loops');
});

test('a global instrument zone supplies what the others leave out', () => {
  const font = testFont();
  const [voice] = voicesFor(font, realPresets(font)[0], 40, LOUD);
  assert.equal(voice.gens[GEN.pan], 100, 'from the global zone');
});

test('a generator nobody sets falls back to what the spec says', () => {
  const font = testFont();
  const [voice] = voicesFor(font, realPresets(font)[0], 40, LOUD);
  assert.equal(voice.gens[GEN.scaleTuning], DEFAULTS[GEN.scaleTuning]);
  assert.equal(voice.gens[GEN.overridingRootKey], -1, 'meaning ask the sample');
  assert.equal(voice.gens[GEN.initialFilterFc], 13500, 'wide open');
});

test('a preset generator is added to the instrument, not put in its place', () => {
  const font = testFont();
  const [voice] = voicesFor(font, realPresets(font)[0], 40, LOUD);
  // The instrument says nothing about tuning, so the default of 0 plus the
  // preset's 2 is 2. This is the rule the whole format turns on.
  assert.equal(voice.gens[GEN.coarseTune], 2);

  const louder = parseSf2(buildSf2({
    pcm: [0, 1, 2],
    instrumentZones: [[gen(GEN.initialAttenuation, 100), gen(GEN.sampleID, 0)]],
    presetZones: [[gen(GEN.initialAttenuation, 40), gen(GEN.instrument, 0)]],
  }));
  const [sum] = voicesFor(louder, realPresets(louder)[0], 60, LOUD);
  assert.equal(sum.gens[GEN.initialAttenuation], 140, 'added, not replaced');
});

test('a preset key range filters rather than adding', () => {
  const font = parseSf2(buildSf2({
    pcm: [0, 1, 2],
    instrumentZones: [[gen(GEN.keyRange, { lo: 0, hi: 127 }), gen(GEN.sampleID, 0)]],
    presetZones: [[gen(GEN.keyRange, { lo: 60, hi: 72 }), gen(GEN.instrument, 0)]],
  }));
  const preset = realPresets(font)[0];
  assert.equal(voicesFor(font, preset, 64, LOUD).length, 1, 'inside the preset range');
  assert.equal(voicesFor(font, preset, 30, LOUD).length, 0, 'outside it');
});

test('velocity picks a layer the same way a key does', () => {
  // Marked with pan rather than loudness: velocity moves loudness by itself,
  // and the question here is only which zone was chosen.
  const font = parseSf2(buildSf2({
    pcm: [0, 1, 2],
    instrumentZones: [
      [gen(GEN.velRange, { lo: 0, hi: 63 }), gen(GEN.pan, -500), gen(GEN.sampleID, 0)],
      [gen(GEN.velRange, { lo: 64, hi: 127 }), gen(GEN.pan, 500), gen(GEN.sampleID, 0)],
    ],
    presetZones: [[gen(GEN.instrument, 0)]],
  }));
  const preset = realPresets(font)[0];
  assert.equal(voicesFor(font, preset, 60, 30)[0].gens[GEN.pan], -500, 'the soft layer');
  assert.equal(voicesFor(font, preset, 60, 100)[0].gens[GEN.pan], 500, 'the loud one');
});

test('two zones over one key are two voices, which is how a piano is made', () => {
  const font = parseSf2(buildSf2({
    pcm: [0, 1, 2],
    instrumentZones: [
      [gen(GEN.keyRange, { lo: 0, hi: 127 }), gen(GEN.pan, -500), gen(GEN.sampleID, 0)],
      [gen(GEN.keyRange, { lo: 0, hi: 127 }), gen(GEN.pan, 500), gen(GEN.sampleID, 0)],
    ],
    presetZones: [[gen(GEN.instrument, 0)]],
  }));
  const voices = voicesFor(font, realPresets(font)[0], 60, LOUD);
  assert.equal(voices.length, 2);
  assert.deepEqual(voices.map((v) => v.gens[GEN.pan]).sort((a, b) => a - b), [-500, 500]);
});

test('a zone pointing at a sample that is not there is skipped, not played', () => {
  const font = parseSf2(buildSf2({
    pcm: [0, 1, 2],
    instrumentZones: [[gen(GEN.sampleID, 40)]],
    presetZones: [[gen(GEN.instrument, 0)]],
  }));
  assert.deepEqual(voicesFor(font, realPresets(font)[0], 60, LOUD), []);
});

/* --------------------------------------------------------- finding a preset */

test('a bank and program find their preset, and fall back when they cannot', () => {
  const font = parseSf2(buildSf2({ pcm: [0, 1], bank: 0, program: 5, presetZones: [[gen(GEN.instrument, 0)]], instrumentZones: [[gen(GEN.sampleID, 0)]] }));
  assert.equal(presetFor(font, 0, 5).program, 5);
  assert.equal(presetFor(font, 0, 9).program, 5, 'something rather than silence');
  assert.equal(presetFor(font, 128, 0).program, 5, 'even for a drum kit');
});

/* ------------------------------------------------------------ conversions */

test('the units a SoundFont counts in', () => {
  assert.ok(Math.abs(centsToHz(6900) - 440) < 0.1, 'A440 is 6900 absolute cents');
  assert.ok(Math.abs(timecentsToSeconds(0) - 1) < 1e-9, 'zero timecents is a second');
  // -12000 is two to the minus ten, which is 0.977ms. The spec rounds it to a
  // millisecond in prose and the difference has never mattered to anybody.
  assert.ok(Math.abs(timecentsToSeconds(-12000) - 2 ** -10) < 1e-12);
  assert.ok(timecentsToSeconds(-12000) < 0.001);
  assert.equal(centibelsToGain(0), 1);
  assert.ok(Math.abs(centibelsToGain(200) - 0.1) < 1e-9, '20dB down is a tenth');
});

/* ----------------------------------------------------------- modulators */

/** A source operator, packed the way the format packs one. */
const source = (index, { cc = 0, decreasing = 0, bipolar = 0, curve = 0 } = {}) =>
  index | (cc << 7) | (decreasing << 8) | (bipolar << 9) | (curve << 10);

test('a source operator unpacks into the five things it says', () => {
  const op = source(SOURCE.velocity, { decreasing: 1, curve: 1 });
  assert.deepEqual(readSource(op), {
    index: 2, isCC: false, decreasing: true, bipolar: false, curve: 1,
  });
  const cc = readSource(source(74, { cc: 1, bipolar: 1 }));
  assert.equal(cc.index, 74);
  assert.equal(cc.isCC, true);
  assert.equal(cc.bipolar, true);
});

test('a straight source passes through, and a falling one is one minus it', () => {
  assert.equal(shape(0.25, source(SOURCE.velocity)), 0.25);
  assert.equal(shape(0.25, source(SOURCE.velocity, { decreasing: 1 })), 0.75);
});

test('a bipolar source runs from minus one to one', () => {
  assert.equal(shape(0, source(SOURCE.keyNumber, { bipolar: 1 })), -1);
  assert.equal(shape(0.5, source(SOURCE.keyNumber, { bipolar: 1 })), 0);
  assert.equal(shape(1, source(SOURCE.keyNumber, { bipolar: 1 })), 1);
});

test('a switch source is off below halfway and on above it', () => {
  const op = source(SOURCE.velocity, { curve: 3 });
  assert.equal(shape(0.49, op), 0);
  assert.equal(shape(0.51, op), 1);
});

test('the curves keep their ends, whichever way round they run', () => {
  for (const curve of [0, 1, 2, 3]) {
    assert.equal(shape(0, source(SOURCE.velocity, { curve })), 0, `curve ${curve} at nought`);
    assert.equal(shape(1, source(SOURCE.velocity, { curve })), 1, `curve ${curve} at one`);
    assert.equal(shape(0, source(SOURCE.velocity, { curve, decreasing: 1 })), 1, `falling ${curve}`);
    assert.equal(shape(1, source(SOURCE.velocity, { curve, decreasing: 1 })), 0, `falling ${curve}`);
  }
});

test('a concave curve is not a straight line, and bends the way it should', () => {
  const op = source(SOURCE.velocity, { curve: 1 });
  const half = shape(0.5, op);
  assert.ok(half > 0.5, `concave rises above the diagonal, got ${half}`);
  // Rising the whole way, and steeper at the bottom than at the top.
  assert.ok(shape(0.2, op) > shape(0.1, op));
  assert.ok(shape(0.2, op) - shape(0.1, op) > shape(0.9, op) - shape(0.8, op));
});

test('the velocity to loudness routing gives the response a sampler gives', () => {
  const [loudness] = DEFAULT_MODULATORS;
  const dbAt = (velocity) => modulatorValue(loudness, { velocity, key: 60 }).value / 10;
  assert.ok(Math.abs(dbAt(127)) < 1e-9, 'full velocity is untouched');
  assert.ok(Math.abs(dbAt(64) - 6) < 0.5, `about six decibels at halfway, got ${dbAt(64)}`);
  assert.ok(dbAt(1) > 35 && dbAt(1) < 50, `and about forty at the bottom, got ${dbAt(1)}`);
  // Never louder than the zone asked for, and always falling with velocity.
  let previous = -1;
  for (let v = 127; v >= 1; v -= 1) {
    const db = dbAt(v);
    assert.ok(db >= previous, 'quieter all the way down');
    previous = db;
  }
});

test('the velocity to cutoff routing opens the filter as you play harder', () => {
  const [, cutoff] = DEFAULT_MODULATORS;
  const at = (velocity) => modulatorValue(cutoff, { velocity, key: 60 }).value;
  assert.ok(Math.abs(at(127)) < 1e-9, 'wide open at full');
  assert.ok(at(64) < 0 && at(1) < at(64), 'and closing as it softens');
});

test('a source gridi cannot read contributes nothing rather than a guess', () => {
  for (const index of [SOURCE.channelPressure, SOURCE.pitchWheel, SOURCE.polyPressure]) {
    const mod = { source: source(index), dest: GEN.initialFilterFc, amount: 2400, amountSource: 0, transform: 0 };
    assert.equal(modulatorValue(mod, { velocity: 100, key: 60 }).value, 0);
  }
  const wheel = { source: source(1, { cc: 1 }), dest: GEN.pan, amount: 500, amountSource: 0, transform: 0 };
  assert.equal(modulatorValue(wheel, { velocity: 100, key: 60 }).value, 0, 'and neither does a CC');
});

test('a modulator pointed at another modulator is left alone', () => {
  const linked = { source: source(SOURCE.velocity), dest: 0x8000 | 5, amount: 100, amountSource: 0, transform: 0 };
  assert.equal(modulatorValue(linked, { velocity: 100, key: 60 }).dest, -1);
});

test('a second source scales the amount', () => {
  const mod = {
    source: source(SOURCE.velocity),
    dest: GEN.initialFilterFc,
    amount: 1000,
    amountSource: source(SOURCE.keyNumber),
    transform: 0,
  };
  const low = modulatorValue(mod, { velocity: 127, key: 0 }).value;
  const high = modulatorValue(mod, { velocity: 127, key: 127 }).value;
  assert.ok(Math.abs(low) < 1e-9, 'nothing at the bottom of the keyboard');
  assert.ok(Math.abs(high - 1000) < 1e-9, 'and the whole amount at the top');
});

test('an absolute transform drops the sign', () => {
  const mod = {
    source: source(SOURCE.keyNumber, { bipolar: 1 }),
    dest: GEN.initialFilterFc,
    amount: 1000,
    amountSource: 0,
    transform: 2,
  };
  assert.ok(modulatorValue(mod, { velocity: 100, key: 0 }).value > 0, 'a fall becomes a rise');
});

test('a zone modulator replaces the default it reads and writes the same as', () => {
  const gentler = { ...DEFAULT_MODULATORS[0], amount: 480 };
  const stacked = stackModulators(DEFAULT_MODULATORS, [gentler]);
  assert.equal(stacked.length, DEFAULT_MODULATORS.length, 'no second loudness routing');
  assert.equal(stacked[0].amount, 480);
});

test('a zone modulator that reads something else is added, not swapped in', () => {
  const extra = {
    source: source(SOURCE.keyNumber),
    dest: GEN.initialFilterFc,
    amount: 600,
    amountSource: 0,
    transform: 0,
  };
  const stacked = stackModulators(DEFAULT_MODULATORS, [extra]);
  assert.equal(stacked.length, DEFAULT_MODULATORS.length + 1);
});

test('applying a modulator adds to the generator rather than setting it', () => {
  const gens = { [GEN.initialAttenuation]: 100 };
  applyModulators(gens, [DEFAULT_MODULATORS[0]], { velocity: 64, key: 60 });
  assert.ok(gens[GEN.initialAttenuation] > 100, 'the zone keeps its own 100');
  assert.ok(gens[GEN.initialAttenuation] < 200, 'and velocity adds about sixty');
});

test('velocity reaches loudness and cutoff on a font that says nothing about it', () => {
  const plain = parseSf2(buildSf2({
    pcm: [0, 1, 2],
    instrumentZones: [[gen(GEN.sampleID, 0)]],
    presetZones: [[gen(GEN.instrument, 0)]],
  }));
  const preset = realPresets(plain)[0];
  const loud = voicesFor(plain, preset, 60, 127)[0].gens;
  const soft = voicesFor(plain, preset, 60, 40)[0].gens;
  assert.ok(soft[GEN.initialAttenuation] > loud[GEN.initialAttenuation], 'softer is quieter');
  assert.ok(soft[GEN.initialFilterFc] < loud[GEN.initialFilterFc], 'and darker');
});
