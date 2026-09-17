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

  noteOn(channel, note, velocity, at, durationSec) {
    const out = this.output;
    if (!out) return;
    const ch = clamp(Math.round(channel), 1, 16) - 1;
    const n = clamp(Math.round(note), 0, 127);
    const v = clamp(Math.round(velocity), 1, 127);
    const start = this.toMidiTime(at);
    const end = start + Math.max(10, durationSec * 1000);
    try {
      out.send([0x90 | ch, n, v], start);
      out.send([0x80 | ch, n, 0], end);
      this.sounding.add(`${ch}:${n}`);
    } catch {
      /* port closed mid-send */
    }
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
  }
}
