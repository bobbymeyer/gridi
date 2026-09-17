import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDegree, noteName, SCALES } from '../src/music.js';

test('degree 1 is the root', () => {
  assert.equal(resolveDegree(1, 'major', 0, 4), 60); // C4
  assert.equal(resolveDegree(1, 'major', 9, 4), 69); // A4
});

test('degrees walk the scale', () => {
  assert.equal(resolveDegree(3, 'major', 0, 4), 64); // E4
  assert.equal(resolveDegree(5, 'minor', 0, 4), 67);
});

test('extend mode carries past the scale into the next octave', () => {
  // A 9th in a 7-note scale is the 2nd, an octave up.
  assert.equal(resolveDegree(9, 'major', 0, 4), resolveDegree(2, 'major', 0, 4) + 12);
  assert.equal(resolveDegree(15, 'major', 0, 4), 60 + 24);
});

test('fold mode stays inside one octave', () => {
  assert.equal(resolveDegree(9, 'major', 0, 4, 'fold'), resolveDegree(2, 'major', 0, 4));
});

test('clamp mode stops at the top of the scale', () => {
  assert.equal(resolveDegree(99, 'major', 0, 4, 'clamp'), resolveDegree(7, 'major', 0, 4));
});

test('negative degrees run below the root', () => {
  assert.equal(resolveDegree(0, 'major', 0, 4), resolveDegree(7, 'major', 0, 3));
  assert.ok(resolveDegree(-6, 'major', 0, 4) < 60);
});

test('pentatonic wraps on five, not seven', () => {
  assert.equal(resolveDegree(6, 'minPent', 0, 4), resolveDegree(1, 'minPent', 0, 4) + 12);
});

test('note names follow MIDI convention', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61), 'C#4');
  assert.equal(noteName(21), 'A0');
});

test('every scale is sorted and inside an octave', () => {
  for (const [key, scale] of Object.entries(SCALES)) {
    assert.ok(scale.steps.length > 0, key);
    assert.equal(scale.steps[0], 0, key);
    assert.ok(scale.steps.every((s, i) => i === 0 || s > scale.steps[i - 1]), key);
    assert.ok(scale.steps.at(-1) < 12, key);
  }
});
