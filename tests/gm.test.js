// Program changes, and the sounds a patch asks for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GM_PROGRAMS, GM_KITS, programName, programsFor, DRUM_CHANNEL } from '../src/gm.js';
import {
  createPatch, createNode, addNode, connect, createChannel, createSound,
  usedChannels, soundFor, setSound, serialize, deserialize,
} from '../src/model.js';
import { Engine } from '../src/engine.js';
import { fakeMidi, fakeAudio, wiredMidi } from './helpers.js';

/* ------------------------------------------------------------ the sound set */

test('the General MIDI set is all hundred and twenty-eight of it', () => {
  assert.equal(GM_PROGRAMS.length, 128);
  assert.ok(GM_PROGRAMS.every((n) => typeof n === 'string' && n.length > 0));
  // Spot checks against the chart, remembering that the chart counts from one.
  assert.equal(GM_PROGRAMS[0], 'Acoustic Grand Piano');
  assert.equal(GM_PROGRAMS[32], 'Acoustic Bass');
  assert.equal(GM_PROGRAMS[73], 'Flute');
  assert.equal(GM_PROGRAMS[127], 'Gunshot');
});

test('a number on the drum channel is a kit, and anywhere else an instrument', () => {
  assert.equal(programName(24, DRUM_CHANNEL), 'Electronic Kit');
  assert.equal(programName(24, 3), 'Acoustic Guitar (nylon)');
  assert.equal(programsFor(DRUM_CHANNEL).length, Object.keys(GM_KITS).length);
  assert.equal(programsFor(3).length, 128);
});

test('a program with no name is still named', () => {
  assert.match(programName(200, 1), /200/);
  assert.match(programName(3, DRUM_CHANNEL), /3/);
});

/* ------------------------------------------------ what a patch asks for */

function patchOn(...channels) {
  const p = createPatch('sounding');
  p.bpm = 120;
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  channels.forEach((ch, i) => {
    const note = addNode(p, createNode('note', 20, i * 6, { audition: false }));
    const line = connect(p, clock.id, note.id);
    line.channelMode = 'set';
    line.channels = [createChannel(ch)];
  });
  return p;
}

test('a patch reports the channels it really plays on', () => {
  assert.deepEqual(usedChannels(patchOn(2, 10)), [
    { out: 'A', ch: 2 },
    { out: 'A', ch: 10 },
  ]);
});

test('a channel nothing reaches is not one the patch plays on', () => {
  const p = patchOn(2);
  // A Note with its MIDI turned off is a voice for the browser, not the wire.
  const muted = addNode(p, createNode('note', 20, 30, { midiOn: false }));
  const line = connect(p, p.nodes[0].id, muted.id);
  line.channelMode = 'set';
  line.channels = [createChannel(9)];
  assert.deepEqual(usedChannels(p).map((c) => c.ch), [2]);
});

test('a Param only counts as a channel when it is sending CC', () => {
  const p = createPatch('cc');
  const clock = addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const inside = addNode(p, createNode('param', 20, 0, { scope: 'signal', param: 'velocity' }));
  const wire = addNode(p, createNode('param', 20, 8, { scope: 'midi', cc: 74 }));
  for (const target of [inside, wire]) {
    const line = connect(p, clock.id, target.id);
    line.channelMode = 'set';
    line.channels = [createChannel(target === wire ? 5 : 6)];
  }
  assert.deepEqual(usedChannels(p).map((c) => c.ch), [5]);
});

test('a patch that loops back on itself still answers', () => {
  const p = patchOn(2);
  const [clock, note] = p.nodes;
  connect(p, note.id, clock.id); // a Pulse takes no input, so this is refused
  const back = addNode(p, createNode('split', 40, 0));
  connect(p, note.id, back.id);
  connect(p, back.id, note.id);
  assert.deepEqual(usedChannels(p).map((c) => c.ch), [2]);
});

test('setting, reading and clearing a sound', () => {
  const p = patchOn(2, 10);
  assert.equal(soundFor(p, 'A', 2), null, 'a new patch has no opinion');
  setSound(p, 'A', 2, 32);
  setSound(p, 'A', 10, 24);
  assert.equal(soundFor(p, 'A', 2), 32);
  assert.equal(soundFor(p, 'A', 10), 24);
  setSound(p, 'A', 2, 33);
  assert.equal(p.sounds.filter((s) => s.ch === 2).length, 1, 'one entry a channel');
  assert.equal(soundFor(p, 'A', 2), 33);
  setSound(p, 'A', 2, null);
  assert.equal(soundFor(p, 'A', 2), null);
  assert.equal(p.sounds.length, 1);
});

test('sounds survive a save and an open, and rubbish in one does not', () => {
  const p = patchOn(2);
  setSound(p, 'A', 2, 32);
  assert.deepEqual(deserialize(serialize(p)).sounds, [createSound(2, 32)]);

  const messy = {
    name: 'messy',
    nodes: [],
    lines: [],
    sounds: [
      { out: 'A', ch: 2, program: 32 },
      { out: 'A', ch: 2, program: 40 }, // a second opinion about one channel
      { out: 'Z', ch: 99, program: 999 }, // out of range in every direction
      { ch: 'nonsense' },
      null,
    ],
  };
  const back = deserialize(JSON.stringify(messy));
  assert.equal(back.sounds.length, 2);
  assert.deepEqual(back.sounds[0], createSound(2, 32), 'the first entry wins');
  assert.deepEqual(back.sounds[1], { out: 'A', ch: 16, program: 127 }, 'and the rest is clamped');
});

/* ------------------------------------------------------- down the wire */

test('starting the transport puts every channel on its sound first', () => {
  const p = patchOn(2, 10);
  setSound(p, 'A', 2, 32);
  setSound(p, 'A', 10, 24);
  const audio = fakeAudio();
  const midi = fakeMidi();
  const engine = new Engine({ getPatch: () => p, audio, midi });
  engine.start();
  for (let t = 0; t < 1; t += 0.02) {
    audio.t = t;
    engine.tick();
  }
  assert.deepEqual(
    midi.programs.map((m) => [m.ch, m.program]),
    [[2, 32], [10, 24]],
  );
  const firstNote = Math.min(...midi.notes.map((n) => n.at));
  for (const sent of midi.programs) {
    assert.ok(sent.at < firstNote - 0.02, 'and with room to act on it');
  }
});

test('a patch with no opinion sends nothing', () => {
  const p = patchOn(2);
  const audio = fakeAudio();
  const midi = fakeMidi();
  const engine = new Engine({ getPatch: () => p, audio, midi });
  engine.start();
  assert.deepEqual(midi.programs, []);
});

test('a program change is a program change on the wire', async () => {
  const { midi, ports } = await wiredMidi();
  assert.ok(midi.sendProgram({ channel: 3, program: 32, at: 0 }));
  assert.ok(midi.sendProgram({ channel: 10, program: 24, at: 0 }));
  assert.deepEqual(ports.A.sends.map((s) => s.data), [
    [0xc2, 32], // 0xC0 | channel 3 counting from zero
    [0xc9, 24],
  ]);
});

test('a program change is held to the range the wire allows', async () => {
  const { midi, ports } = await wiredMidi();
  midi.sendProgram({ channel: 99, program: 999, at: 0 });
  midi.sendProgram({ channel: -4, program: -8, at: 0 });
  assert.deepEqual(ports.A.sends.map((s) => s.data), [[0xcf, 127], [0xc0, 0]]);
});

test('with nothing bound, sending a program says so rather than throwing', async () => {
  const { midi } = await wiredMidi({ slots: { A: 'p1' } });
  assert.equal(midi.sendProgram({ slot: 'B', channel: 1, program: 4, at: 0 }), false);
});
