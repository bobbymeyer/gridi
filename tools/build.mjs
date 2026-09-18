// Writes the library: every patch file, and the index that lists them.
//
//   node tools/build.mjs
//
// Run it after changing any of the builders. The index is written from the same
// list the files are, so the two cannot drift apart. `tests/library.test.js`
// checks that what is on disk is what this produces.

import { writeFileSync } from 'node:fs';
import { serialize } from '../src/model.js';
import { bossaPatch } from './bossa.mjs';
import { sambaPatch } from './samba.mjs';
import { housePatch } from './house.mjs';
import { hiphopPatch } from './hiphop.mjs';
import { ambientPatch } from './ambient.mjs';

export const LIBRARY = [
  {
    file: 'bossa-nova.json',
    build: bossaPatch,
    note: 'ii-V-I in C. The clave is drawn as distance, one cell a sixteenth.',
  },
  {
    file: 'samba.json',
    build: sambaPatch,
    note: 'Caixa, surdo, tamborim and agogô. The surdo is a beat further out, which puts it on two and four.',
  },
  {
    file: 'house.json',
    build: housePatch,
    note: 'Four to the floor at 124. The open hat is the kick’s clock, drawn an eighth longer.',
  },
  {
    file: 'hiphop.json',
    build: hiphopPatch,
    note: 'Boom-bap at 88, hats swung. One clock a bar, three kicks at their own distances.',
  },
  {
    file: 'ambient.json',
    build: ambientPatch,
    note: 'Five loops of 5, 7, 11, 13 and 16 beats. They come back into line once a day.',
  },
];

export function build() {
  const index = { patches: [] };
  for (const entry of LIBRARY) {
    const patch = entry.build();
    writeFileSync(new URL(`../patches/${entry.file}`, import.meta.url), serialize(patch));
    index.patches.push({ file: entry.file, name: patch.name, note: entry.note });
  }
  writeFileSync(
    new URL('../patches/index.json', import.meta.url),
    `${JSON.stringify(index, null, 2)}\n`,
  );
  return index;
}

if (process.argv[1]?.endsWith('build.mjs')) {
  const index = build();
  for (const e of index.patches) process.stdout.write(`${e.file}  ${e.name}\n`);
}
