// Voice bookkeeping: what the engine holds on to, and what it lets go.
//
// AudioEngine's constructor touches no DOM and its allocation bookkeeping is
// plain object work, so the part that matters — every voice eventually being
// retired and disconnected — can be checked here rather than only by ear.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine, GLOBAL_VOICE_CAP } from '../src/audio.js';

/** Stands in for a connected AudioNode. */
function fakeNode() {
  return { disconnects: 0, disconnect() { this.disconnects += 1; } };
}

function fakeVoice(owner, start) {
  return {
    owner,
    start,
    chain: [fakeNode(), fakeNode()],
    oscillators: [],
    amp: { gain: { value: 0.5, cancelScheduledValues() {}, setValueAtTime() {}, exponentialRampToValueAtTime() {} } },
  };
}

test('retiring a voice drops it and disconnects its chain', () => {
  const engine = new AudioEngine();
  const voice = fakeVoice('a', 0);
  engine.voices.push(voice);
  engine.retire(voice);
  assert.equal(engine.voices.length, 0);
  assert.deepEqual(voice.chain.map((n) => n.disconnects), [1, 1]);
});

test('retiring twice disconnects once', () => {
  const engine = new AudioEngine();
  const voice = fakeVoice('a', 0);
  engine.voices.push(voice);
  engine.retire(voice);
  engine.retire(voice);
  assert.deepEqual(voice.chain.map((n) => n.disconnects), [1, 1]);
});

test('retiring one voice leaves the others alone', () => {
  const engine = new AudioEngine();
  const keep = fakeVoice('a', 0);
  const go = fakeVoice('b', 1);
  engine.voices.push(keep, go);
  engine.retire(go);
  assert.deepEqual(engine.voices, [keep]);
  assert.deepEqual(keep.chain.map((n) => n.disconnects), [0, 0]);
});

test('stealing frees the slot immediately', () => {
  const engine = new AudioEngine();
  const voice = fakeVoice('a', 0);
  engine.voices.push(voice);
  engine.steal(voice, 1);
  assert.equal(engine.voices.length, 0, 'the slot is free for the note taking its place');
});

test('stealing survives a voice whose graph has already gone', () => {
  const engine = new AudioEngine();
  const voice = fakeVoice('a', 0);
  voice.amp.gain.cancelScheduledValues = () => { throw new Error('gone'); };
  engine.voices.push(voice);
  assert.doesNotThrow(() => engine.steal(voice, 1));
  assert.equal(engine.voices.length, 0);
});

test('panic retires everything', () => {
  const engine = new AudioEngine();
  const voices = [fakeVoice('a', 0), fakeVoice('a', 1), fakeVoice('b', 2)];
  engine.voices.push(...voices);
  engine.allOff();
  assert.equal(engine.voices.length, 0);
  for (const v of voices) assert.deepEqual(v.chain.map((n) => n.disconnects), [1, 1]);
});

test('a source is forgotten once it ends', () => {
  const engine = new AudioEngine();
  const source = {};
  let ended = 0;
  engine.register(source, () => { ended += 1; });
  assert.equal(engine.live.size, 1);
  source.onended();
  assert.equal(engine.live.size, 0);
  assert.equal(ended, 1);
});

test('registering without a callback still cleans up', () => {
  const engine = new AudioEngine();
  const source = {};
  engine.register(source);
  source.onended();
  assert.equal(engine.live.size, 0);
});

test('the global ceiling is a real limit, not a placeholder', () => {
  assert.ok(Number.isInteger(GLOBAL_VOICE_CAP) && GLOBAL_VOICE_CAP > 0 && GLOBAL_VOICE_CAP <= 256);
});
