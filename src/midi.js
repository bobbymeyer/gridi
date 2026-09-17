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

export const MIDI_SUPPORTED = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;

/**
 * How far ahead a note-off is handed to the port. Short, because a note-off
 * held in our own queue can still be brought forward when the same note is
 * retriggered, and one already given to the port cannot be taken back.
 */
const OFF_FLUSH_AHEAD = 0.08;

/** A retriggered note is released this long before it sounds again. */
const RETRIGGER_GAP = 0.001;

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
    this.onChange();
  }

  /** AudioContext seconds -> DOMHighResTimeStamp, the domain MIDI schedules in. */
  toMidiTime(audioTime) {
    return performance.now() + (audioTime - this.clock.now()) * 1000;
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
