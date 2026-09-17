import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  euclid, patternString, stepBeats, stepOnsetBeats, emitterFiresOn,
  gridBeats, cellsPerBar, GRID_KEYS, DEFAULT_GRID,
} from '../src/rhythm.js';

test('euclid spreads hits evenly', () => {
  assert.equal(patternString(euclid(3, 8)), 'x..x..x.'); // tresillo
  assert.equal(patternString(euclid(5, 8)), 'x.xx.xx.'); // cinquillo family
  assert.equal(patternString(euclid(4, 4)), 'xxxx');
  assert.equal(patternString(euclid(0, 4)), '....');
});

test('euclid rotation shifts the pattern', () => {
  assert.equal(patternString(euclid(3, 8, 1)), '..x..x.x');
  assert.equal(euclid(3, 8, 8).join(), euclid(3, 8).join());
});

test('euclid clamps pulses to steps', () => {
  assert.equal(patternString(euclid(12, 4)), 'xxxx');
});

test('division and polyrhythm ratio set step length', () => {
  assert.equal(stepBeats('1/4'), 1);
  assert.equal(stepBeats('1/16'), 0.25);
  assert.ok(Math.abs(stepBeats('1/8T') - 1 / 3) < 1e-9);
  // 3 steps in the space of 4 quarter notes -> each is 4/3 beats.
  assert.ok(Math.abs(stepBeats('1/4', 3, 4) - 4 / 3) < 1e-9);
});

test('swing delays only the off-steps', () => {
  assert.equal(stepOnsetBeats(0, 0.25, 0.2), 0);
  assert.equal(stepOnsetBeats(1, 0.25, 0.2), 0.25 + 0.05);
  assert.equal(stepOnsetBeats(2, 0.25, 0.2), 0.5);
  // Straight time when swing is off.
  assert.equal(stepOnsetBeats(3, 0.25, 0), 0.75);
});

test('swing never reorders steps', () => {
  let prev = -1;
  for (let i = 0; i < 32; i += 1) {
    const t = stepOnsetBeats(i, 0.25, 0.6);
    assert.ok(t > prev, `step ${i}`);
    prev = t;
  }
});

test('euclid gating is off unless enabled', () => {
  const off = { euclidOn: false };
  assert.ok(emitterFiresOn(5, off));
  const on = { euclidOn: true, euclidPulses: 3, euclidSteps: 8, euclidRotate: 0 };
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((s) => emitterFiresOn(s, on)), [
    true, false, false, true, false, false, true, false,
  ]);
  assert.equal(emitterFiresOn(8, on), true); // wraps
});

/* ------------------------------------------------------------- the grid */

test('a cell is worth an eighth note until told otherwise', () => {
  assert.equal(DEFAULT_GRID, '1/8');
  assert.equal(gridBeats(DEFAULT_GRID), 0.5);
  assert.equal(gridBeats(undefined), 0.5, 'and nonsense falls back to it');
  assert.equal(gridBeats('1/3'), 0.5, 'as does a value that is not on offer');
});

test('refining the grid makes each cell worth less', () => {
  assert.equal(gridBeats('1/4'), 1);
  assert.equal(gridBeats('1/16'), 0.25);
  assert.ok(gridBeats('1/32') < gridBeats('1/16'));
  for (const key of GRID_KEYS) assert.ok(gridBeats(key) > 0, key);
});

test('the heavy rules are bar lines whatever the grid is set to', () => {
  assert.equal(cellsPerBar('1/8'), 8); // four quarters, eight cells
  assert.equal(cellsPerBar('1/16'), 16);
  assert.equal(cellsPerBar('1/4'), 4);
  for (const key of GRID_KEYS) {
    const cells = cellsPerBar(key);
    assert.equal(cells, Math.round(cells), `${key} lands between rules`);
    assert.ok(Math.abs(cells * gridBeats(key) - 4) < 1e-9, `${key} is not a bar`);
  }
});
