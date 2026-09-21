// Builds a small but real SoundFont, in memory.
//
// Testing a binary parser against a file nobody can read is testing nothing,
// so the fixture is written here, byte by byte, from the same record layout the
// parser claims to read. When the two disagree one of them is wrong, which is
// the point.

const RECORD = { phdr: 38, pbag: 4, pgen: 4, inst: 22, ibag: 4, igen: 4, shdr: 46 };

function chunk(tag, body) {
  const out = new Uint8Array(8 + body.length + (body.length % 2));
  for (let i = 0; i < 4; i += 1) out[i] = tag.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function list(kind, parts) {
  const body = concat([ascii(kind), ...parts]);
  return chunk('LIST', body);
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

function padded(text, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < Math.min(text.length, length - 1); i += 1) out[i] = text.charCodeAt(i);
  return out;
}

function record(size, write) {
  const out = new Uint8Array(size);
  write(new DataView(out.buffer), out);
  return out;
}

/** A generator, as it sits in a pgen or igen table. */
export function gen(id, value) {
  return record(RECORD.pgen, (v) => {
    v.setUint16(0, id, true);
    if (typeof value === 'object') { v.setUint8(2, value.lo); v.setUint8(3, value.hi); }
    else v.setInt16(2, value, true);
  });
}

/**
 * @param {object} spec
 * @param {string} spec.name
 * @param {number[]} spec.pcm  sample frames, -32768..32767
 * @param {number[]} [spec.pcmLow]  the low byte of each frame, for a 24-bit file
 * @param {object} spec.sample  the sample header's own fields
 * @param {object[]} [spec.samples]  several headers, where one is not enough
 * @param {Uint8Array[][]} spec.instrumentZones  generator lists, global first
 * @param {Uint8Array[][]} spec.presetZones
 * @param {number} spec.bank
 * @param {number} spec.program
 */
export function buildSf2({
  name = 'Test Font',
  pcm = [],
  pcmLow = null,
  sample = {},
  samples = null,
  instrumentZones = [],
  presetZones = [],
  bank = 0,
  program = 0,
} = {}) {
  const headers = (samples ?? [sample]).map((s, i) => ({
    name: `sample${i || ''}`,
    start: 0,
    end: pcm.length,
    loopStart: 0,
    loopEnd: pcm.length,
    sampleRate: 22050,
    rootKey: 60,
    correction: 0,
    link: 0,
    type: 1,
    ...s,
  }));

  const smpl = new Uint8Array(pcm.length * 2);
  const smplView = new DataView(smpl.buffer);
  pcm.forEach((v, i) => smplView.setInt16(i * 2, v, true));
  const sm24 = pcmLow ? Uint8Array.from(pcmLow) : null;

  // Bags point at where their generators start; the terminal record of each
  // table points one past the end, which is how a reader knows where to stop.
  const igen = [];
  const ibag = [];
  for (const zone of instrumentZones) {
    ibag.push(record(RECORD.ibag, (v) => { v.setUint16(0, igen.length, true); }));
    igen.push(...zone);
  }
  ibag.push(record(RECORD.ibag, (v) => { v.setUint16(0, igen.length, true); }));

  const pgen = [];
  const pbag = [];
  for (const zone of presetZones) {
    pbag.push(record(RECORD.pbag, (v) => { v.setUint16(0, pgen.length, true); }));
    pgen.push(...zone);
  }
  pbag.push(record(RECORD.pbag, (v) => { v.setUint16(0, pgen.length, true); }));

  const phdr = [
    record(RECORD.phdr, (v, bytes) => {
      bytes.set(padded('Test Preset', 20), 0);
      v.setUint16(20, program, true);
      v.setUint16(22, bank, true);
      v.setUint16(24, 0, true);
    }),
    record(RECORD.phdr, (v, bytes) => {
      bytes.set(padded('EOP', 20), 0);
      v.setUint16(24, pbag.length - 1, true);
    }),
  ];

  const inst = [
    record(RECORD.inst, (v, bytes) => {
      bytes.set(padded('Test Instrument', 20), 0);
      v.setUint16(20, 0, true);
    }),
    record(RECORD.inst, (v, bytes) => {
      bytes.set(padded('EOI', 20), 0);
      v.setUint16(20, ibag.length - 1, true);
    }),
  ];

  const shdr = [
    ...headers.map((header) => record(RECORD.shdr, (v, bytes) => {
      bytes.set(padded(header.name, 20), 0);
      v.setUint32(20, header.start, true);
      v.setUint32(24, header.end, true);
      v.setUint32(28, header.loopStart, true);
      v.setUint32(32, header.loopEnd, true);
      v.setUint32(36, header.sampleRate, true);
      v.setUint8(40, header.rootKey);
      v.setInt8(41, header.correction);
      v.setUint16(42, header.link, true);
      v.setUint16(44, header.type, true);
    })),
    record(RECORD.shdr, (v, bytes) => { bytes.set(padded('EOS', 20), 0); }),
  ];

  const body = concat([
    ascii('sfbk'),
    list('INFO', [
      chunk('ifil', Uint8Array.from([2, 0, 1, 0])),
      chunk('INAM', padded(name, name.length + 1)),
    ]),
    list('sdta', sm24 ? [chunk('smpl', smpl), chunk('sm24', sm24)] : [chunk('smpl', smpl)]),
    list('pdta', [
      chunk('phdr', concat(phdr)),
      chunk('pbag', concat(pbag)),
      chunk('pmod', new Uint8Array(10)),
      chunk('pgen', concat(pgen)),
      chunk('inst', concat(inst)),
      chunk('ibag', concat(ibag)),
      chunk('imod', new Uint8Array(10)),
      chunk('igen', concat(igen)),
      chunk('shdr', concat(shdr)),
    ]),
  ]);

  const file = chunk('RIFF', body);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}
