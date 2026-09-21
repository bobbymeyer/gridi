// Reading a SoundFont: the chunks, and the zone model on top of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSf2, voicesFor, presetFor, realPresets, GEN, DEFAULTS,
  timecentsToSeconds, centibelsToGain, centsToHz,
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

test('a key picks the zone whose range covers it', () => {
  const font = testFont();
  const preset = realPresets(font)[0];

  const low = voicesFor(font, preset, 40, 100);
  assert.equal(low.length, 1);
  assert.equal(low[0].gens[GEN.attackVolEnv], -3000);
  assert.equal(low[0].gens[GEN.initialAttenuation], 60);

  const high = voicesFor(font, preset, 72, 100);
  assert.equal(high.length, 1);
  assert.equal(high[0].gens[GEN.attackVolEnv], -1200);
  assert.equal(high[0].gens[GEN.sampleModes], 1, 'and this one loops');
});

test('a global instrument zone supplies what the others leave out', () => {
  const font = testFont();
  const [voice] = voicesFor(font, realPresets(font)[0], 40, 100);
  assert.equal(voice.gens[GEN.pan], 100, 'from the global zone');
});

test('a generator nobody sets falls back to what the spec says', () => {
  const font = testFont();
  const [voice] = voicesFor(font, realPresets(font)[0], 40, 100);
  assert.equal(voice.gens[GEN.scaleTuning], DEFAULTS[GEN.scaleTuning]);
  assert.equal(voice.gens[GEN.overridingRootKey], -1, 'meaning ask the sample');
  assert.equal(voice.gens[GEN.initialFilterFc], 13500, 'wide open');
});

test('a preset generator is added to the instrument, not put in its place', () => {
  const font = testFont();
  const [voice] = voicesFor(font, realPresets(font)[0], 40, 100);
  // The instrument says nothing about tuning, so the default of 0 plus the
  // preset's 2 is 2. This is the rule the whole format turns on.
  assert.equal(voice.gens[GEN.coarseTune], 2);

  const louder = parseSf2(buildSf2({
    pcm: [0, 1, 2],
    instrumentZones: [[gen(GEN.initialAttenuation, 100), gen(GEN.sampleID, 0)]],
    presetZones: [[gen(GEN.initialAttenuation, 40), gen(GEN.instrument, 0)]],
  }));
  const [sum] = voicesFor(louder, realPresets(louder)[0], 60, 100);
  assert.equal(sum.gens[GEN.initialAttenuation], 140, 'added, not replaced');
});

test('a preset key range filters rather than adding', () => {
  const font = parseSf2(buildSf2({
    pcm: [0, 1, 2],
    instrumentZones: [[gen(GEN.keyRange, { lo: 0, hi: 127 }), gen(GEN.sampleID, 0)]],
    presetZones: [[gen(GEN.keyRange, { lo: 60, hi: 72 }), gen(GEN.instrument, 0)]],
  }));
  const preset = realPresets(font)[0];
  assert.equal(voicesFor(font, preset, 64, 100).length, 1, 'inside the preset range');
  assert.equal(voicesFor(font, preset, 30, 100).length, 0, 'outside it');
});

test('velocity picks a layer the same way a key does', () => {
  const font = parseSf2(buildSf2({
    pcm: [0, 1, 2],
    instrumentZones: [
      [gen(GEN.velRange, { lo: 0, hi: 63 }), gen(GEN.initialAttenuation, 90), gen(GEN.sampleID, 0)],
      [gen(GEN.velRange, { lo: 64, hi: 127 }), gen(GEN.initialAttenuation, 10), gen(GEN.sampleID, 0)],
    ],
    presetZones: [[gen(GEN.instrument, 0)]],
  }));
  const preset = realPresets(font)[0];
  assert.equal(voicesFor(font, preset, 60, 30)[0].gens[GEN.initialAttenuation], 90);
  assert.equal(voicesFor(font, preset, 60, 100)[0].gens[GEN.initialAttenuation], 10);
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
  const voices = voicesFor(font, realPresets(font)[0], 60, 100);
  assert.equal(voices.length, 2);
  assert.deepEqual(voices.map((v) => v.gens[GEN.pan]).sort((a, b) => a - b), [-500, 500]);
});

test('a zone pointing at a sample that is not there is skipped, not played', () => {
  const font = parseSf2(buildSf2({
    pcm: [0, 1, 2],
    instrumentZones: [[gen(GEN.sampleID, 40)]],
    presetZones: [[gen(GEN.instrument, 0)]],
  }));
  assert.deepEqual(voicesFor(font, realPresets(font)[0], 60, 100), []);
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
