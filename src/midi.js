// Web MIDI output.
//
// Notes are sent with explicit timestamps rather than "now", so they land with
// the same accuracy as the audio. Web MIDI timestamps are in the
// performance.now() domain while the scheduler works in AudioContext seconds,
// so every send crosses between the two.
//
// Support note: Chrome, Edge, Opera and Firefox 108+. Not Safari, and not any
// iOS browser, since they all run WebKit. A secure context is required.

import { clamp } from './util.js';
import { LIMITS, RateMeter } from './limits.js';

export const MIDI_SUPPORTED = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;

/**
 * How far ahead a note-off is handed to the port. Short, because a note-off
 * held in our own queue can still be brought forward when the same note is
 * retriggered, and one already given to the port cannot be taken back.
 */
const OFF_FLUSH_AHEAD = 0.08;

/** A retriggered note is released this long before it sounds again. */
const RETRIGGER_GAP = 0.001;

/* System real-time and common messages. */
export const CLOCK = 0xf8;
export const START = 0xfa;
export const CONTINUE = 0xfb;
export const STOP = 0xfc;
export const SONG_POSITION = 0xf2;

/** MIDI clock is fixed at 24 pulses per quarter note. It is not negotiable. */
export const PPQN = 24;

export class MidiOut {
  /** @param {{now: () => number}} clock the audio clock to convert against */
  constructor(clock) {
    this.clock = clock;
    this.access = null;
    this.outputs = [];
    this.outputId = null;
    this.status = MIDI_SUPPORTED ? 'idle' : 'unsupported';
    this.onChange = () => {};
    this.sounding = new Set(); // "ch:note" currently expected to be down
    this.pendingOffs = []; // note-offs not yet handed to the port
    this.rate = new RateMeter();
    this.governor = null;
    this.timeOffset = null; // performance.now() minus audio time, in ms
  }

  get enabled() {
    return Boolean(this.output);
  }

  get output() {
    if (!this.access || !this.outputId) return null;
    return this.access.outputs.get(this.outputId) ?? null;
  }

  /** Requires a user gesture and a secure context. */
  async enable() {
    if (!MIDI_SUPPORTED) {
      this.status = 'unsupported';
      this.onChange();
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => this.refresh();
      this.refresh();
      this.status = this.outputs.length ? 'ready' : 'no-ports';
      this.onChange();
      return true;
    } catch (err) {
      this.status = err && err.name === 'SecurityError' ? 'denied' : 'error';
      this.onChange();
      return false;
    }
  }

  refresh() {
    if (!this.access) return;
    this.outputs = [...this.access.outputs.values()].map((o) => ({
      id: o.id,
      name: o.name || o.id,
      manufacturer: o.manufacturer || '',
    }));
    if (this.outputId && !this.outputs.some((o) => o.id === this.outputId)) this.outputId = null;
    if (!this.outputId && this.outputs.length) this.outputId = this.outputs[0].id;
    this.status = this.outputs.length ? 'ready' : 'no-ports';
    this.onChange();
  }

  setOutput(id) {
    if (this.outputId && this.outputId !== id) this.allOff();
    this.outputId = id || null;
    this.timeOffset = null; // a new port starts from a fresh reading
    this.onChange();
  }

  /**
   * AudioContext seconds -> DOMHighResTimeStamp, the domain MIDI schedules in.
   *
   * The two clocks do not tick alike: performance.now() advances continuously
   * while AudioContext.currentTime moves in render quanta of a couple of
   * milliseconds and jumps outright when the context first starts. Reading both
   * per message therefore wobbles the conversion, and measured that way the
   * clock pulses jittered between 3ms and 27ms around a 20.8ms target — enough
   * for a receiver to read it as an unsteady tempo.
   *
   * So the offset between the clocks is held, not recomputed: resynced hard
   * when it is plainly wrong, and otherwise nudged towards what is observed, so
   * slow drift is tracked without the per-message noise.
   */
  syncTime() {
    const observed = performance.now() - this.clock.now() * 1000;
    if (this.timeOffset === null || Math.abs(observed - this.timeOffset) > 50) {
      this.timeOffset = observed;
    } else {
      this.timeOffset += (observed - this.timeOffset) * 0.02;
    }
    return this.timeOffset;
  }

  toMidiTime(audioTime) {
    if (this.timeOffset === null) this.syncTime();
    return this.timeOffset + audioTime * 1000;
  }

  /**
   * Schedule a note.
   *
   * The note-off is queued rather than sent, because MIDI has no concept of
   * "this note, specifically" — a note-off is just a channel and a pitch. If
   * the same pitch is retriggered on the same channel before the first one
   * ends, sending both note-offs up front means the earlier one cuts the later
   * note short, and the last one arrives with nothing sounding. Holding them
   * lets a retrigger release the previous note first instead.
   */
  noteOn(channel, note, velocity, at, durationSec) {
    const out = this.output;
    if (!out) return;
    const ch = clamp(Math.round(channel), 1, 16) - 1;
    const n = clamp(Math.round(note), 0, 127);
    const v = clamp(Math.round(velocity), 1, 127);
    const key = `${ch}:${n}`;
    const end = at + Math.max(0.01, durationSec);

    // Throttle note-ons only. Dropping a note-off would leave a note sounding
    // on the receiving instrument with nothing left to release it.
    const now = this.clock.now();
    if (this.rate.rate(now) > LIMITS.midiPerSecond) {
      this.governor?.trip('midi', now, 'notes dropped');
      return;
    }
    this.rate.add(now, 2); // this note-on and the note-off it will need

    // Release anything of this pitch still due to be held past our start.
    for (const off of this.pendingOffs) {
      if (off.key !== key || off.time <= at) continue;
      this.sendOff(off, Math.max(at - RETRIGGER_GAP, off.start));
    }
    this.pendingOffs = this.pendingOffs.filter((off) => !off.done);

    try {
      out.send([0x90 | ch, n, v], this.toMidiTime(at));
    } catch {
      return; // port closed mid-send
    }
    this.sounding.add(key);
    this.pendingOffs.push({ key, ch, note: n, start: at, time: end, done: false });
  }

  /**
   * Clock and transport messages go straight out, past the note throttle.
   *
   * Dropping one is worse than sending it late: a missing clock pulse reads as
   * a tempo stumble at the far end, and a missing Stop leaves the receiver
   * running. Their rate is bounded by the tempo anyway — 24 per quarter note is
   * 120 a second even at 300bpm — so they cannot be the thing that floods a
   * port. They still count towards the meter, so notes give way before they do.
   */
  sendRealtime(bytes, at) {
    const out = this.output;
    if (!out) return;
    this.rate.add(this.clock.now(), bytes.length === 1 ? 1 : bytes.length);
    try {
      out.send(bytes, this.toMidiTime(at));
    } catch {
      /* port closed mid-send */
    }
  }

  /** One clock pulse. Twenty-four of these make a quarter note. */
  sendClock(at) {
    this.sendRealtime([CLOCK], at);
  }

  /**
   * Song position, counted in sixteenth notes — MIDI's own idea of a "beat".
   * Sent before Continue so the receiver knows where in the song to resume.
   */
  sendSongPosition(sixteenths, at) {
    const value = clamp(Math.round(sixteenths), 0, 16383);
    this.sendRealtime([SONG_POSITION, value & 0x7f, (value >> 7) & 0x7f], at);
  }

  sendStart(at) {
    this.sendRealtime([START], at);
  }

  sendContinue(at) {
    this.sendRealtime([CONTINUE], at);
  }

  sendStop(at) {
    this.sendRealtime([STOP], at);
  }

  /** Hand one queued note-off to the port, optionally earlier than planned. */
  sendOff(off, at = off.time) {
    if (off.done) return;
    off.done = true;
    this.sounding.delete(off.key);
    try {
      this.output?.send([0x80 | off.ch, off.note, 0], this.toMidiTime(at));
    } catch {
      /* port closed mid-send */
    }
  }

  /**
   * Hand over the note-offs now close enough to be due. Called from the
   * scheduler tick, on the same clock as everything else.
   */
  flush(audioNow) {
    this.syncTime(); // once a tick, rather than once a message
    if (!this.pendingOffs.length) return;
    const horizon = audioNow + OFF_FLUSH_AHEAD;
    for (const off of this.pendingOffs) {
      if (off.time <= horizon) this.sendOff(off);
    }
    this.pendingOffs = this.pendingOffs.filter((off) => !off.done);
  }

  /** Cancel anything pending and silence every channel. */
  allOff() {
    const out = this.output;
    if (!out) return;
    try {
      if (typeof out.clear === 'function') out.clear();
      for (const key of this.sounding) {
        const [ch, n] = key.split(':').map(Number);
        out.send([0x80 | ch, n, 0]);
      }
      for (let ch = 0; ch < 16; ch += 1) {
        out.send([0xb0 | ch, 123, 0]); // all notes off
        out.send([0xb0 | ch, 120, 0]); // all sound off
      }
    } catch {
      /* ignore */
    }
    this.sounding.clear();
    this.pendingOffs.length = 0;
  }
}
