// Reading a SoundFont.
//
// A .sf2 file is RIFF: a header, a block of 16-bit samples, and a set of
// parallel tables describing how to play them. Nothing here touches the audio
// API, so the whole of it can be read and checked outside a browser.
//
// The shape to hold in your head is two levels of the same idea. A preset has
// zones; each zone names an instrument and a key and velocity range. An
// instrument has zones; each names a sample and its own ranges. Playing a note
// means finding every preset zone that covers it, then every instrument zone
// under those that covers it too, and sounding all of them at once -- which is
// how one General MIDI piano is a dozen recordings.
//
// The one rule that catches everyone: generators on an instrument zone are the
// value, and generators on a preset zone are added to it.

/** Generator numbers worth naming. The rest are read but not acted on. */
export const GEN = {
  startAddrsOffset: 0,
  endAddrsOffset: 1,
  startloopAddrsOffset: 2,
  endloopAddrsOffset: 3,
  startAddrsCoarseOffset: 4,
  initialFilterFc: 8,
  initialFilterQ: 9,
  pan: 17,
  delayVolEnv: 33,
  attackVolEnv: 34,
  holdVolEnv: 35,
  decayVolEnv: 36,
  sustainVolEnv: 37,
  releaseVolEnv: 38,
  instrument: 41,
  keyRange: 43,
  velRange: 44,
  initialAttenuation: 48,
  endloopAddrsCoarseOffset: 50,
  coarseTune: 51,
  fineTune: 52,
  sampleID: 53,
  sampleModes: 54,
  scaleTuning: 56,
  overridingRootKey: 58,
  endAddrsCoarseOffset: 12,
  startloopAddrsCoarseOffset: 45,
};

/**
 * What a generator means when nobody sets it.
 *
 * Only the ones this player acts on are here. A missing default is zero, which
 * is right for every offset and wrong for none of them.
 */
export const DEFAULTS = {
  [GEN.initialFilterFc]: 13500, // absolute cents, which is about 20kHz: open
  [GEN.initialFilterQ]: 0,
  [GEN.pan]: 0,
  [GEN.delayVolEnv]: -12000, // timecents, which is a millisecond: none
  [GEN.attackVolEnv]: -12000,
  [GEN.holdVolEnv]: -12000,
  [GEN.decayVolEnv]: -12000,
  [GEN.sustainVolEnv]: 0, // centibels of attenuation, which is none
  [GEN.releaseVolEnv]: -12000,
  [GEN.initialAttenuation]: 0,
  [GEN.coarseTune]: 0,
  [GEN.fineTune]: 0,
  [GEN.sampleModes]: 0,
  [GEN.scaleTuning]: 100,
  [GEN.overridingRootKey]: -1, // meaning: whatever the sample says
};

/** Generators a preset zone may not set, because they belong to the sample. */
const INSTRUMENT_ONLY = new Set([
  GEN.startAddrsOffset, GEN.endAddrsOffset, GEN.startloopAddrsOffset,
  GEN.endloopAddrsOffset, GEN.startAddrsCoarseOffset, GEN.endAddrsCoarseOffset,
  GEN.startloopAddrsCoarseOffset, GEN.endloopAddrsCoarseOffset,
  GEN.sampleID, GEN.sampleModes, GEN.instrument,
  GEN.keyRange, GEN.velRange, // ranges filter at preset level, they do not add
]);

const RECORD = { phdr: 38, pbag: 4, pgen: 4, pmod: 10, inst: 22, ibag: 4, igen: 4, imod: 10, shdr: 46 };

const fourcc = (view, at) => String.fromCharCode(
  view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3),
);

function name(view, at, len = 20) {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    const c = view.getUint8(at + i);
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out.trim();
}

/**
 * Walk the chunks of a RIFF list, giving each one's tag, offset and length.
 * A chunk with an odd length is followed by a pad byte that is not its own.
 */
function* chunks(view, from, to) {
  let at = from;
  while (at + 8 <= to) {
    const tag = fourcc(view, at);
    const size = view.getUint32(at + 4, true);
    yield { tag, at: at + 8, size };
    at += 8 + size + (size % 2);
  }
}

/** Read a table of fixed-size records, dropping the terminal one. */
function table(view, chunk, size, read) {
  const count = Math.floor(chunk.size / size);
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(read(view, chunk.at + i * size));
  return out;
}

/**
 * Parse a .sf2 into the tables it is made of.
 *
 * @param {ArrayBuffer} buffer
 * @returns {object} the raw tables plus the sample block
 */
export function parseSf2(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || fourcc(view, 0) !== 'RIFF' || fourcc(view, 8) !== 'sfbk') {
    throw new Error('not a SoundFont');
  }
  const end = Math.min(8 + view.getUint32(4, true), buffer.byteLength);

  const found = {};
  let samples = null;
  let info = {};
  for (const list of chunks(view, 12, end)) {
    if (list.tag !== 'LIST') continue;
    const kind = fourcc(view, list.at);
    const from = list.at + 4;
    const to = list.at + list.size;
    for (const chunk of chunks(view, from, to)) {
      if (kind === 'sdta' && chunk.tag === 'smpl') {
        const frames = Math.floor(chunk.size / 2);
        // A typed array has to start on a multiple of its own width. RIFF pads
        // chunks to even lengths so this is almost always free, and when it is
        // not the block is copied rather than the file refused.
        samples = chunk.at % 2 === 0
          ? new Int16Array(buffer, chunk.at, frames)
          : new Int16Array(new Uint8Array(buffer, chunk.at, frames * 2).slice().buffer);
      } else if (kind === 'pdta') {
        found[chunk.tag] = chunk;
      } else if (kind === 'INFO' && (chunk.tag === 'INAM' || chunk.tag === 'isng')) {
        info[chunk.tag] = name(view, chunk.at, chunk.size);
      }
    }
  }
  for (const need of ['phdr', 'pbag', 'pgen', 'inst', 'ibag', 'igen', 'shdr']) {
    if (!found[need]) throw new Error(`SoundFont has no ${need}`);
  }

  const bag = (v, at) => ({ gen: v.getUint16(at, true), mod: v.getUint16(at + 2, true) });
  const gen = (v, at) => ({ id: v.getUint16(at, true), amount: at + 2 });
  const mod = (v, at) => ({
    source: v.getUint16(at, true),
    dest: v.getUint16(at + 2, true),
    amount: v.getInt16(at + 4, true),
    amountSource: v.getUint16(at + 6, true),
    transform: v.getUint16(at + 8, true),
  });

  return {
    name: info.INAM || '',
    samples: samples ?? new Int16Array(0),
    presets: table(view, found.phdr, RECORD.phdr, (v, at) => ({
      name: name(v, at),
      program: v.getUint16(at + 20, true),
      bank: v.getUint16(at + 22, true),
      bagIndex: v.getUint16(at + 24, true),
    })),
    presetBags: table(view, found.pbag, RECORD.pbag, bag),
    presetGens: table(view, found.pgen, RECORD.pgen, gen),
    presetMods: found.pmod ? table(view, found.pmod, RECORD.pmod, mod) : [],
    instruments: table(view, found.inst, RECORD.inst, (v, at) => ({
      name: name(v, at),
      bagIndex: v.getUint16(at + 20, true),
    })),
    instrumentBags: table(view, found.ibag, RECORD.ibag, bag),
    instrumentGens: table(view, found.igen, RECORD.igen, gen),
    instrumentMods: found.imod ? table(view, found.imod, RECORD.imod, mod) : [],
    headers: table(view, found.shdr, RECORD.shdr, (v, at) => ({
      name: name(v, at),
      start: v.getUint32(at + 20, true),
      end: v.getUint32(at + 24, true),
      loopStart: v.getUint32(at + 28, true),
      loopEnd: v.getUint32(at + 32, true),
      sampleRate: v.getUint32(at + 36, true),
      rootKey: v.getUint8(at + 40),
      correction: v.getInt8(at + 41),
      link: v.getUint16(at + 42, true),
      type: v.getUint16(at + 44, true),
    })),
    view,
  };
}

/* ------------------------------------------------------------------- zones */

/** A generator's value, read the way its number says to read it. */
function amount(view, at, id) {
  if (id === GEN.keyRange || id === GEN.velRange) {
    return { lo: view.getUint8(at), hi: view.getUint8(at + 1) };
  }
  // Ranges aside, generators are signed except the handful of indices, and
  // reading an index as signed only matters past 32767 zones, which no file has.
  return view.getInt16(at, true);
}

/** The generators of one bag, as a plain object keyed by generator number. */
function gensOf(font, gens, bags, index) {
  const from = bags[index].gen;
  const to = index + 1 < bags.length ? bags[index + 1].gen : gens.length;
  const out = {};
  for (let i = from; i < to && i < gens.length; i += 1) {
    out[gens[i].id] = amount(font.view, gens[i].amount, gens[i].id);
  }
  return out;
}

/** The modulators of one bag. */
function modsOf(mods, bags, index) {
  const from = bags[index].mod;
  const to = index + 1 < bags.length ? bags[index + 1].mod : mods.length;
  return mods.slice(from, Math.max(from, Math.min(to, mods.length)));
}

/**
 * Split a run of bags into a global zone and the real ones.
 *
 * A zone counts as real when it ends by naming the thing below it -- an
 * instrument for a preset, a sample for an instrument. A first zone that names
 * neither is the global one, and its generators are the defaults for the rest.
 */
function zonesOf(font, gens, mods, bags, from, to, terminator) {
  const zones = [];
  let global = { gens: {}, mods: [] };
  for (let i = from; i < to && i < bags.length; i += 1) {
    const found = gensOf(font, gens, bags, i);
    const routings = modsOf(mods, bags, i);
    if (found[terminator] === undefined) {
      if (zones.length === 0) global = { gens: found, mods: routings };
      continue; // a zone naming nothing, in the middle, is nothing
    }
    zones.push({ gens: found, mods: routings });
  }
  return { global, zones };
}

const covers = (range, value) => !range || (value >= range.lo && value <= range.hi);

/** Preset bag runs, worked out once so a note lookup is only arithmetic. */
function runFor(items, bags, index) {
  const from = items[index].bagIndex;
  const to = index + 1 < items.length ? items[index + 1].bagIndex : bags.length;
  return { from, to };
}

/**
 * Everything that should sound for one note of one preset.
 *
 * Returns a list, not a single answer: a preset can layer several samples on
 * one key, and General MIDI fonts routinely do.
 *
 * @returns {object[]} one entry per sample to play
 */
export function voicesFor(font, preset, key, velocity, controllers = null) {
  const index = font.presets.indexOf(preset);
  if (index < 0) return [];
  const out = [];
  const run = runFor(font.presets, font.presetBags, index);
  const { global: presetGlobal, zones: presetZones } = zonesOf(
    font, font.presetGens, font.presetMods, font.presetBags, run.from, run.to, GEN.instrument,
  );
  const context = { key, velocity, controllers };

  for (const zone of presetZones) {
    const outer = { ...presetGlobal.gens, ...zone.gens };
    if (!covers(outer[GEN.keyRange], key) || !covers(outer[GEN.velRange], velocity)) continue;
    const instrument = font.instruments[outer[GEN.instrument]];
    if (!instrument) continue;
    const outerMods = stackModulators(presetGlobal.mods, zone.mods);

    const inner = runFor(font.instruments, font.instrumentBags, outer[GEN.instrument]);
    const { global: instGlobal, zones: instZones } = zonesOf(
      font, font.instrumentGens, font.instrumentMods, font.instrumentBags,
      inner.from, inner.to, GEN.sampleID,
    );

    for (const instZone of instZones) {
      const gens = { ...DEFAULTS, ...instGlobal.gens, ...instZone.gens };
      if (!covers(gens[GEN.keyRange], key) || !covers(gens[GEN.velRange], velocity)) continue;

      // A preset zone's numbers are offsets onto the instrument's, which is the
      // rule that makes one instrument serve a dozen presets.
      for (const [id, value] of Object.entries(outer)) {
        const num = Number(id);
        if (INSTRUMENT_ONLY.has(num) || typeof value !== 'number') continue;
        gens[num] = (typeof gens[num] === 'number' ? gens[num] : 0) + value;
      }

      // Modulators last, on top of everything the generators settled. An
      // instrument's own routing replaces the default that reads and writes
      // the same things; a preset's is added to whatever came out of that.
      const routings = stackModulators(
        stackModulators(DEFAULT_MODULATORS, instGlobal.mods),
        instZone.mods,
      );
      applyModulators(gens, routings, context);
      applyModulators(gens, outerMods, context);

      const header = font.headers[gens[GEN.sampleID]];
      if (!header || header.end <= header.start) continue;
      out.push({ header, gens, sampleIndex: gens[GEN.sampleID] });
    }
  }
  return out;
}

/**
 * The presets a player may choose from.
 *
 * Every table in a SoundFont ends with a terminal record whose only job is to
 * mark where the last real one's data stops. The zone arithmetic needs it, so
 * it stays in the table; nothing else should ever see it.
 */
export const realPresets = (font) => font.presets.slice(0, -1);

/**
 * The preset for a bank and program, falling back the way a General MIDI
 * player is expected to: the same program in bank zero, then any drum kit for
 * a drum request, then anything at all, so an incomplete font makes a sound
 * rather than silence.
 */
export function presetFor(font, bank, program) {
  const presets = realPresets(font);
  return presets.find((p) => p.bank === bank && p.program === program)
    ?? presets.find((p) => p.bank === 0 && p.program === program)
    ?? (bank === 128 ? presets.find((p) => p.bank === 128) : undefined)
    ?? presets[0];
}

/* ------------------------------------------------------------- conversions */

/** Timecents to seconds. -12000 is a millisecond, which the spec calls none. */
export const timecentsToSeconds = (tc) => 2 ** (tc / 1200);

/** Centibels of attenuation to a gain multiplier. 100 centibels is 10dB down. */
export const centibelsToGain = (cb) => 10 ** (-cb / 200);

/** Absolute cents to Hz, where 6900 is A440. */
export const centsToHz = (cents) => 8.176 * 2 ** (cents / 1200);

/* -------------------------------------------------------------- modulators */

/**
 * Modulators are the routings that make an instrument respond.
 *
 * A generator says "this zone is 12dB down". A modulator says "and another
 * 40dB down as the velocity falls away". One is a setting, the other is what
 * makes a sampled instrument feel played rather than triggered.
 *
 * Each one reads a source, bends it through a curve, multiplies by an amount
 * and adds the result to a generator. A second source can scale the amount,
 * which is how a font says "velocity opens the filter, but only up high".
 */

/** The controllers a source can name, when it is not a MIDI CC. */
export const SOURCE = {
  none: 0,
  velocity: 2,
  keyNumber: 3,
  polyPressure: 10,
  channelPressure: 13,
  pitchWheel: 14,
  pitchWheelSensitivity: 16,
};

/** The parts packed into a source operator's sixteen bits. */
export function readSource(operator) {
  return {
    index: operator & 0x7f,
    isCC: ((operator >> 7) & 1) === 1,
    // A decreasing source runs from one down to zero as the controller rises.
    decreasing: ((operator >> 8) & 1) === 1,
    bipolar: ((operator >> 9) & 1) === 1,
    curve: (operator >> 10) & 0x3f,
  };
}

/**
 * The concave curve, which is the spec's, normalised over its 96dB span.
 *
 * `1 + (20/96)·log10(x)` is a decibel ramp read as a fraction: it climbs
 * steeply out of silence and then flattens, so the quiet half of a velocity
 * range is spread out and the loud half is not. That shape is the whole reason
 * a sampled piano played softly sounds soft rather than just quieter.
 */
function concave(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return Math.max(0, 1 + (20 / 96) * Math.log10(x));
}

/** The same curve the other way up. */
const convex = (x) => 1 - concave(1 - x);

/**
 * A source value, bent through the curve its operator names.
 *
 * A decreasing source flips the *output*, not the input. For a straight line
 * the two are the same thing, which is why it is easy to get wrong; for a
 * curve they are not, and getting it the other way round makes the standard
 * velocity-to-loudness routing put a note at velocity 100 eighty decibels
 * down. Flipping the output gives the response every sampler has: full at 127,
 * about six decibels down at halfway, about forty at the very bottom.
 */
export function shape(value, operator) {
  const src = readSource(operator);
  const x = Math.min(Math.max(value, 0), 1);
  let y;
  if (src.curve === 1) y = concave(x);
  else if (src.curve === 2) y = convex(x);
  else if (src.curve === 3) y = x < 0.5 ? 0 : 1;
  else y = x;
  if (src.decreasing) y = 1 - y;
  return src.bipolar ? y * 2 - 1 : y;
}

/**
 * What a source reads, from nought to one.
 *
 * Gridi has velocity and key and nothing else: no wheel, no aftertouch, no
 * expression pedal. A modulator reading one of those is left at zero rather
 * than guessed at, which means it contributes nothing -- correct, and quieter
 * than inventing a value.
 */
function sourceValue(operator, { velocity, key, controllers }) {
  const src = readSource(operator);
  if (src.isCC) return (controllers?.[src.index] ?? 0) / 127;
  switch (src.index) {
    case SOURCE.none: return 1;
    case SOURCE.velocity: return velocity / 127;
    case SOURCE.keyNumber: return key / 127;
    default: return 0;
  }
}

/** What one modulator adds to its destination. */
export function modulatorValue(mod, context) {
  // A destination with the high bit set is a link to another modulator rather
  // than a generator. Chained modulators are rare and are not followed.
  if ((mod.dest & 0x8000) !== 0) return { dest: -1, value: 0 };

  const primary = shape(sourceValue(mod.source, context), mod.source);
  const secondary = readSource(mod.amountSource).index === SOURCE.none
    && !readSource(mod.amountSource).isCC
    ? 1
    : shape(sourceValue(mod.amountSource, context), mod.amountSource);

  let value = mod.amount * primary * secondary;
  if (mod.transform === 2) value = Math.abs(value);
  return { dest: mod.dest, value };
}

/**
 * The modulators every SoundFont has whether it says so or not.
 *
 * Only the two that gridi can actually drive are here. The spec's other eight
 * read the mod wheel, the pedals, aftertouch and the pitch bender, none of
 * which reach the internal player -- carrying them would be writing code that
 * multiplies by zero.
 */
export const DEFAULT_MODULATORS = [
  // Velocity to attenuation, concave and falling: the loudness curve.
  { source: 0x0502, dest: GEN.initialAttenuation, amount: 960, amountSource: 0, transform: 0 },
  // Velocity to filter cutoff, falling: play harder, open it up.
  { source: 0x0102, dest: GEN.initialFilterFc, amount: -2400, amountSource: 0, transform: 0 },
];

/** Two modulators are the same one when they read and write the same things. */
const sameRouting = (a, b) => a.source === b.source
  && a.dest === b.dest
  && a.amountSource === b.amountSource
  && a.transform === b.transform;

/**
 * Gather a zone's modulators over the defaults.
 *
 * A modulator on an instrument zone replaces a default that reads and writes
 * the same things, rather than adding to it -- otherwise a font that wants a
 * gentler velocity curve would get its own on top of the standard one.
 */
export function stackModulators(base, added) {
  const out = [...base];
  for (const mod of added) {
    const at = out.findIndex((existing) => sameRouting(existing, mod));
    if (at >= 0) out[at] = mod;
    else out.push(mod);
  }
  return out;
}

/** Add every modulator's contribution to the generators it writes to. */
export function applyModulators(gens, mods, context) {
  for (const mod of mods) {
    const { dest, value } = modulatorValue(mod, context);
    if (dest < 0 || value === 0) continue;
    gens[dest] = (typeof gens[dest] === 'number' ? gens[dest] : 0) + value;
  }
  return gens;
}
