// The shelf: the patches somebody keeps in their own browser.
//
// The list is the whole of it — storage and markup are elsewhere — so what is
// worth testing is the part that decides what replaces what, and that a shelf
// written by an older or damaged copy of the app still opens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readShelf, writeShelf, keepPatch, removePatch, copyName, indexOfName,
} from '../src/shelf.js';

const patch = (name) => `{"app":"gridi","name":"${name}"}`;

test('a shelf survives the round trip through storage', () => {
  const list = keepPatch([], 'Tuesday', patch('Tuesday'), 1000);
  const back = readShelf(writeShelf(list));
  assert.deepEqual(back, [{ name: 'Tuesday', patch: patch('Tuesday'), saved: 1000 }]);
});

test('anything unreadable is an empty shelf, not an exception', () => {
  assert.deepEqual(readShelf(null), []);
  assert.deepEqual(readShelf(''), []);
  assert.deepEqual(readShelf('not json'), []);
  assert.deepEqual(readShelf('{"v":1}'), []);
  assert.deepEqual(readShelf('{"v":1,"patches":"nope"}'), []);
  // An entry with no patch in it is nothing to open, so it is dropped rather
  // than left on the shelf as a cell that does nothing.
  assert.deepEqual(readShelf('{"v":1,"patches":[{"name":"x"},{"name":"y","patch":"{}"}]}'),
    [{ name: 'y', patch: '{}', saved: 0 }]);
});

test('a bare array is read too, in case the shape ever changes back', () => {
  assert.deepEqual(readShelf('[{"name":"a","patch":"{}","saved":3}]'),
    [{ name: 'a', patch: '{}', saved: 3 }]);
});

test('keeping under a name already on the shelf replaces it', () => {
  let list = keepPatch([], 'Bossa', patch('one'), 1);
  list = keepPatch(list, 'Samba', patch('two'), 2);
  list = keepPatch(list, 'Bossa', patch('three'), 3);
  assert.equal(list.length, 2, 'two names, two entries');
  assert.equal(list[0].name, 'Bossa', 'the one just kept reads first');
  assert.equal(list[0].patch, patch('three'), 'and it is the new version');
});

test('case is not a second patch', () => {
  let list = keepPatch([], 'Bossa', patch('one'), 1);
  list = keepPatch(list, 'BOSSA', patch('two'), 2);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'BOSSA', 'the name is kept as it was typed');
  assert.equal(indexOfName(list, 'bossa'), 0);
});

test('a patch with no name is kept under one anyway', () => {
  const list = keepPatch([], '   ', patch('x'), 1);
  assert.equal(list[0].name, 'Untitled', 'or it could never be found again');
});

test('removing takes one entry and leaves the rest', () => {
  let list = keepPatch(keepPatch([], 'a', patch('a')), 'b', patch('b'));
  list = removePatch(list, 'A');
  assert.deepEqual(list.map((e) => e.name), ['b']);
  assert.deepEqual(removePatch(list, 'nothing here').map((e) => e.name), ['b'],
    'removing what is not there changes nothing');
});

test('a copy is named after what it was copied from, and counts up', () => {
  let list = [];
  assert.equal(copyName('Bossa Nova', list), 'Bossa Nova copy');
  list = keepPatch(list, 'Bossa Nova copy', patch('c1'));
  assert.equal(copyName('Bossa Nova', list), 'Bossa Nova copy 2');
  list = keepPatch(list, 'Bossa Nova copy 2', patch('c2'));
  assert.equal(copyName('Bossa Nova', list), 'Bossa Nova copy 3');
});
