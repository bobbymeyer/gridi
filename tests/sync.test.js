// Following an external clock, and letting played notes into the graph.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockFollower, PPQN, MIN_BPM, MAX_BPM, RESYNC_BEATS } from '../src/sync.js';
import { MidiIn, decode } from '../src/midi-in.js';
import { Engine } from '../src/engine.js';
import { createPatch, createNode, addNode, connect } from '../src/model.js';
import { fakeMidi, fakeAudio } from './helpers.js';

const gapFor = (bpm) => 60 / (bpm * PPQN);

/** Feed a follower a steady stream of pulses. */
function drive(follower, { bpm = 120, pulses = 48, from = 0, jitter = 0, rng = () => 0.5 } = {}) {
  let t = from;
  for (let i = 0; i < pulses; i += 1) {
    follower.pulse(t + (jitter ? (rng() - 0.5) * jitter : 0));
    t += gapFor(bpm);
  }
  return t;
}

/* ----------------------------------------------------------- the follower */

test('tempo is recovered from the spacing of pulses', () => {
  for (const bpm of [60, 90, 120, 174, 300]) {
    const f = new ClockFollower();
    f.start();
    drive(f, { bpm });
    assert.ok(Math.abs(f.tempo - bpm) < 0.001, `${bpm} read as ${f.tempo}`);
  }
});

test('nothing is claimed before there is enough to go on', () => {
  const f = new ClockFollower();
  f.start();
  assert.equal(f.tempo, null);
  assert.ok(!f.locked);
  drive(f, { pulses: 3 });
  assert.equal(f.tempo, null, 'three pulses is not a tempo');
  drive(f, { pulses: 8, from: 1 });
  assert.ok(f.locked);
  assert.ok(f.tempo > 0);
});

test('one late pulse does not move the tempo', () => {
  const f = new ClockFollower();
  f.start();
  let t = drive(f, { bpm: 120, pulses: 24 });
  const before = f.tempo;
  f.pulse(t + gapFor(120) * 3); // a pulse arriving very late
  assert.ok(Math.abs(f.tempo - before) < 0.001, 'the median holds where a mean would not');
});

test('jitter is smoothed rather than followed', () => {
  const f = new ClockFollower();
  f.start();
  let seed = 1;
  const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  drive(f, { bpm: 120, pulses: 48, jitter: 0.004, rng });
  assert.ok(Math.abs(f.tempo - 120) < 6, `read ${f.tempo} from a jittery 120`);
});

test('an implausible gap is counted for position but not for tempo', () => {
  const f = new ClockFollower();
  f.start();
  drive(f, { bpm: 120, pulses: 24 });
  const before = f.tempo;
  const beatBefore = f.beat;
  f.pulse(100); // the page was suspended, or a pulse went missing
  assert.equal(f.tempo, before, 'a minute-long gap is not a tempo');
  assert.ok(f.beat > beatBefore, 'but the position still advanced');
});

test('position follows the pulse count', () => {
  const f = new ClockFollower();
  f.start();
  drive(f, { pulses: PPQN });
  assert.ok(Math.abs(f.beat - 1) < 1e-9, 'twenty-four pulses is one beat');
});

test('the master can say where we are', () => {
  const f = new ClockFollower();
  f.start();
  f.locate(16); // sixteen sixteenths is four beats
  assert.equal(f.beat, 4);
  f.locate(0);
  assert.equal(f.beat, 0);
});

test('start resets, continue keeps its place', () => {
  const f = new ClockFollower();
  f.start();
  drive(f, { pulses: 48 });
  const where = f.beat;
  f.stop();
  assert.ok(!f.running);
  f.resume();
  assert.ok(f.running);
  assert.equal(f.beat, where, 'continue picks up where it left off');
  f.start();
  assert.equal(f.beat, 0, 'start goes back to the top');
});

test('the gap across a pause is not read as a tempo', () => {
  const f = new ClockFollower();
  f.start();
  let t = drive(f, { bpm: 120, pulses: 24 });
  f.stop();
  f.resume();
  const before = f.tempo;
  f.pulse(t + 30); // half a minute later
  assert.equal(f.tempo, before);
});

test('phase is eased into, and only jumped when badly out', () => {
  const f = new ClockFollower();
  f.start();
  drive(f, { pulses: PPQN * 2 }); // two beats in
  const small = f.correctionFor(f.beat - 0.05);
  assert.ok(!small.jump);
  assert.ok(small.delta > 0 && small.delta < 0.05, 'a sip of the error, not all of it');

  const large = f.correctionFor(f.beat - (RESYNC_BEATS + 1));
  assert.ok(large.jump, 'a gross error is snapped');
  assert.equal(large.delta, large.error);

  const behind = f.correctionFor(f.beat + 0.05);
  assert.ok(behind.delta < 0, 'and it corrects in both directions');
});

test('tempo is held inside what MIDI can mean', () => {
  const f = new ClockFollower();
  f.start();
  drive(f, { bpm: 120, pulses: 12 });
  assert.ok(f.tempo >= MIN_BPM && f.tempo <= MAX_BPM);
});

/* -------------------------------------------------------------- decoding */

test('messages decode to what they are', () => {
  assert.deepEqual(decode([0xf8]), { type: 'clock' });
  assert.deepEqual(decode([0xfa]), { type: 'start' });
  assert.deepEqual(decode([0xfb]), { type: 'continue' });
  assert.deepEqual(decode([0xfc]), { type: 'stop' });
  assert.deepEqual(decode([0xf2, 4, 2]), { type: 'position', sixteenths: 260 });
  assert.deepEqual(decode([0x91, 60, 100]), { type: 'noteOn', channel: 2, note: 60, velocity: 100 });
  assert.deepEqual(decode([0x81, 60, 64]), { type: 'noteOff', channel: 2, note: 60 });
  assert.deepEqual(decode([0xb0, 74, 30]), { type: 'control', channel: 1, controller: 74, value: 30 });
});

test('a note-on with no velocity is a note-off, as devices mean it', () => {
  assert.deepEqual(decode([0x90, 60, 0]), { type: 'noteOff', channel: 1, note: 60 });
});

test('what we have no use for decodes to nothing', () => {
  assert.equal(decode([0xfe]), null, 'active sensing');
  assert.equal(decode([0xf0, 1, 2]), null, 'sysex');
  assert.equal(decode([]), null);
  assert.equal(decode(null), null);
});

/* ---------------------------------------------------------- the port side */

function inputRig() {
  const port = { onmidimessage: null };
  const clock = { t: 0, now() { return this.t; } };
  const midiIn = new MidiIn({ clock, toAudioTime: (ms) => ms / 1000 });
  midiIn.access = { inputs: new Map([['in', port]]) };
  midiIn.inputs = [{ id: 'in', name: 'Keys', manufacturer: '' }];
  midiIn.setInput('in');
  const seen = [];
  midiIn.onClock = (at) => seen.push({ type: 'clock', at });
  midiIn.onStart = () => seen.push({ type: 'start' });
  midiIn.onStop = () => seen.push({ type: 'stop' });
  midiIn.onNote = (n) => seen.push({ type: 'note', ...n });
  return { midiIn, port, seen, clock, send: (data, ts = 0) => port.onmidimessage({ data, timeStamp: ts }) };
}

test('an incoming message reaches its handler', () => {
  const { send, seen } = inputRig();
  send([0xfa]);
  send([0xf8], 1000);
  send([0x90, 64, 90]);
  send([0xfc]);
  assert.deepEqual(seen.map((s) => s.type), ['start', 'clock', 'note', 'stop']);
  assert.equal(seen[1].at, 1, 'stamped in audio seconds');
  assert.equal(seen[2].note, 64);
});

test('only one port is listened to at a time', () => {
  const { midiIn, port } = inputRig();
  assert.ok(port.onmidimessage);
  midiIn.setInput(null);
  assert.equal(port.onmidimessage, null, 'the old port is let go');
});

test('a device stuck in a loop cannot inject pulses without limit', () => {
  const { send, seen } = inputRig();
  for (let i = 0; i < 5000; i += 1) send([0x90, 60, 100]);
  const notes = seen.filter((s) => s.type === 'note').length;
  assert.ok(notes < 5000, 'the surplus was dropped');
});

/* ------------------------------------------------------ engine following */

function engineRig(patch) {
  const audio = fakeAudio();
  const midi = fakeMidi();
  const transport = [];
  const engine = new Engine({
    getPatch: () => patch,
    audio,
    midi,
    onExternalTransport: (what) => transport.push(what),
  });
  return { engine, audio, midi, transport };
}

test('the engine takes its tempo from the incoming clock', () => {
  const p = createPatch('follow');
  p.bpm = 120;
  p.sync = 'external';
  addNode(p, createNode('pulse', 0, 0, { division: '1/4' }));
  const { engine, audio } = engineRig(p);
  engine.start();
  engine.externalStart();

  // The master runs at 90, not the 120 the patch says.
  let t = 0;
  const gap = gapFor(90);
  for (let i = 0; i < 96; i += 1) {
    audio.t = t;
    engine.externalClock(t);
    engine.tick();
    t += gap;
  }
  assert.ok(Math.abs(engine.bpm - 90) < 1, `engine ran at ${engine.bpm}`);
  assert.equal(p.bpm, 120, 'the patch is not rewritten behind your back');
});

test('the grid converges on the master rather than snapping to it', () => {
  const p = createPatch('phase');
  p.bpm = 120;
  p.sync = 'external';
  const { engine, audio } = engineRig(p);
  engine.start();
  engine.externalStart();

  let t = 0;
  const gap = gapFor(120);
  const errors = [];
  for (let i = 0; i < 120; i += 1) {
    audio.t = t;
    engine.externalClock(t);
    engine.tick();
    errors.push(Math.abs(engine.follower.beat - engine.timeToBeat(t)));
    t += gap;
  }
  const settled = errors.slice(-24).reduce((a, b) => a + b, 0) / 24;
  assert.ok(settled < 0.05, `settled to ${settled} beats of error`);
});

test('transport messages from the master are passed on', () => {
  const p = createPatch('transport');
  p.sync = 'external';
  const { engine, transport } = engineRig(p);
  engine.externalStart();
  engine.externalStop();
  engine.externalContinue();
  assert.deepEqual(transport, ['start', 'stop', 'continue']);
});

test('internal sync ignores the incoming clock entirely', () => {
  const p = createPatch('internal');
  p.bpm = 140;
  p.sync = 'internal';
  const { engine, audio } = engineRig(p);
  engine.start();
  engine.externalStart();
  let t = 0;
  for (let i = 0; i < 96; i += 1) {
    audio.t = t;
    engine.externalClock(t);
    engine.tick();
    t += gapFor(90);
  }
  assert.equal(engine.bpm, 140, 'the project tempo stands');
});

/* -------------------------------------------------------- played notes */

/**
 * Tick on until everything in flight has landed.
 *
 * A played note enters at the Input node and then has to walk the line to
 * whatever it feeds, which takes as long as that line is worth. One tick only
 * ever covers the look-ahead, so these tests run the clock on a little.
 */
function settle(engine, audio, from, seconds = 3) {
  for (let t = from; t < from + seconds; t += 0.02) {
    audio.t = t;
    engine.tick();
  }
}

test('a played note sends a pulse from every Input node listening', () => {
  const p = createPatch('keys');
  p.bpm = 120;
  p.scale = 'major';
  p.root = 0;
  const input = addNode(p, createNode('input', 0, 0, { listen: 0, sets: 'key' }));
  const note = addNode(p, createNode('note', 10, 0, { degree: 1, octave: 4, audition: false }));
  connect(p, input.id, note.id);
  const { engine, audio, midi } = engineRig(p);
  engine.start();
  audio.t = 0.2;
  engine.externalNote({ channel: 1, note: 65, velocity: 90, at: 0.2 });
  settle(engine, audio, 0.2);
  assert.equal(midi.notes.length, 1);
  assert.equal(midi.notes[0].note, 65, 'playing F retunes the patch to F');
  assert.equal(midi.notes[0].vel, 90, 'and the velocity comes through');
});

test('an Input node can be pinned to one channel', () => {
  const p = createPatch('keys');
  p.bpm = 120;
  const input = addNode(p, createNode('input', 0, 0, { listen: 3 }));
  const note = addNode(p, createNode('note', 10, 0, { audition: false }));
  connect(p, input.id, note.id);
  const { engine, audio, midi } = engineRig(p);
  engine.start();
  audio.t = 0.2;
  assert.equal(engine.externalNote({ channel: 2, note: 60, velocity: 90, at: 0.2 }), 0, 'wrong channel');
  assert.equal(engine.externalNote({ channel: 3, note: 60, velocity: 90, at: 0.2 }), 1, 'right channel');
  settle(engine, audio, 0.2);
  assert.equal(midi.notes.length, 1);
});

test('transpose mode shifts rather than retunes', () => {
  const p = createPatch('keys');
  p.bpm = 120;
  p.scale = 'major';
  p.root = 0;
  const input = addNode(p, createNode('input', 0, 0, { sets: 'transpose', base: 60 }));
  const note = addNode(p, createNode('note', 10, 0, { degree: 1, octave: 4, audition: false }));
  connect(p, input.id, note.id);
  const { engine, audio, midi } = engineRig(p);
  engine.start();
  audio.t = 0.2;
  engine.externalNote({ channel: 1, note: 67, velocity: 90, at: 0.2 }); // seven above centre
  settle(engine, audio, 0.2);
  assert.equal(midi.notes[0].note, 67, 'C4 shifted up a fifth');
});

test('gate mode ignores the pitch', () => {
  const p = createPatch('keys');
  p.bpm = 120;
  p.scale = 'major';
  p.root = 0;
  const input = addNode(p, createNode('input', 0, 0, { sets: 'none', useVelocity: false, velocity: 77 }));
  const note = addNode(p, createNode('note', 10, 0, { degree: 1, octave: 4, audition: false }));
  connect(p, input.id, note.id);
  const { engine, audio, midi } = engineRig(p);
  engine.start();
  audio.t = 0.2;
  engine.externalNote({ channel: 1, note: 90, velocity: 12, at: 0.2 });
  settle(engine, audio, 0.2);
  assert.equal(midi.notes[0].note, 60, 'whatever was played, the patch plays its own note');
  assert.equal(midi.notes[0].vel, 77, 'and its own velocity');
});

test('played notes do nothing while the transport is stopped', () => {
  const p = createPatch('keys');
  const input = addNode(p, createNode('input', 0, 0));
  const note = addNode(p, createNode('note', 10, 0, { audition: false }));
  connect(p, input.id, note.id);
  const { engine } = engineRig(p);
  assert.equal(engine.externalNote({ channel: 1, note: 60, velocity: 90, at: 0 }), 0);
});

test('a quantised stream is read at its real tempo, not the rounded one', () => {
  // USB MIDI is polled about once a millisecond, so a 27.78ms interval arrives
  // as a run of 28s with the occasional 27. Taking that at face value reads
  // 89.3bpm from a master running at 90.
  const f = new ClockFollower();
  f.start();
  const trueGap = gapFor(90);
  let t = 0;
  for (let i = 0; i < 48; i += 1) {
    f.pulse(Math.round(t * 1000) / 1000); // land it on a millisecond
    t += trueGap;
  }
  assert.ok(Math.abs(f.tempo - 90) < 0.5, `read ${f.tempo} from a quantised 90`);
});

test('averaging the trusted intervals does not let an outlier back in', () => {
  const f = new ClockFollower();
  f.start();
  let t = drive(f, { bpm: 120, pulses: 20 });
  f.pulse(t + gapFor(120) * 2.5); // one pulse arrives very late
  assert.ok(Math.abs(f.tempo - 120) < 1, `read ${f.tempo} with an outlier present`);
});
