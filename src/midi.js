// Web MIDI output, across several devices at once.
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
 * Outputs are named slots, not devices.
 *
 * A patch says "channel 1 on output B" and each machine binds B to whatever it
 * has. Device ids are assigned by the browser and differ between machines, so a
 * patch storing them directly would arrive somewhere else pointing at nothing.
 */
export const SLOTS = ['A', 'B', 'C', 'D'];
export const DEFAULT_SLOT = 'A';

export const isSlot = (slot) => SLOTS.includes(slot);
export const asSlot = (slot) => (isSlot(slot) ? slot : DEFAULT_SLOT);

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
    this.status = MIDI_SUPPORTED ? 'idle' : 'unsupported';
    this.onChange = () => {};
    this.governor = null;
    this.timeOffset = null; // performance.now() minus audio time, in ms

    // Each slot holds the device bound to it and whether clock goes there.
    this.slots = new Map(SLOTS.map((slot) => [slot, { portId: null, clock: true }]));
    this.sounding = new Set(); // "slot:ch:note" currently expected to be down
    this.pendingOffs = []; // note-offs not yet handed to a port
    this.lastControl = new Map(); // "slot:ch:cc" -> last value sent
    this.rates = new Map(SLOTS.map((slot) => [slot, new RateMeter()]));
  }

  /* ----------------------------------------------------------------- ports */

  get enabled() {
    return this.boundSlots.length > 0;
  }

  /** Slots with a device actually behind them, in slot order. */
  get boundSlots() {
    return SLOTS.filter((slot) => this.portFor(slot));
  }

  portFor(slot) {
    const binding = this.slots.get(slot);
    if (!binding || !binding.portId || !this.access) return null;
    return this.access.outputs.get(binding.portId) ?? null;
  }

  deviceName(slot) {
    return this.outputs.find((o) => o.id === this.slots.get(slot)?.portId)?.name ?? null;
  }

  /** Point a slot at a device, or at nothing. */
  bind(slot, portId) {
    if (!isSlot(slot)) return;
    const binding = this.slots.get(slot);
    if (binding.portId === portId) return;
    if (binding.portId) this.silence(slot); // do not strand notes on the old device
    this.lastControl.clear();
    binding.portId = portId || null;
    this.timeOffset = null; // a new port starts from a fresh reading
    this.onChange();
  }

  sendsClock(slot) {
    return Boolean(this.slots.get(slot)?.clock);
  }

  setSlotClock(slot, on) {
    const binding = this.slots.get(slot);
    if (!binding) return;
    binding.clock = Boolean(on);
    if (!binding.clock && this.portFor(slot)) this.raw(slot, [STOP], this.clock.now());
    this.onChange();
  }

  /** What the app should remember between sessions. */
  bindings() {
    return Object.fromEntries(SLOTS.map((slot) => [slot, { ...this.slots.get(slot) }]));
  }

  restoreBindings(stored) {
    if (!stored || typeof stored !== 'object') return;
    for (const slot of SLOTS) {
      const saved = stored[slot];
      if (!saved || typeof saved !== 'object') continue;
      const binding = this.slots.get(slot);
      binding.clock = saved.clock !== false;
      // Only rebind to a device this machine still has.
      binding.portId = this.outputs.some((o) => o.id === saved.portId) ? saved.portId : null;
    }
    this.onChange();
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
    // Drop bindings whose device has gone away, and give slot A a home.
    for (const slot of SLOTS) {
      const binding = this.slots.get(slot);
      if (binding.portId && !this.outputs.some((o) => o.id === binding.portId)) binding.portId = null;
    }
    const first = this.slots.get(DEFAULT_SLOT);
    if (!first.portId && this.outputs.length && !this.boundSlots.length) {
      first.portId = this.outputs[0].id;
    }
    this.status = this.outputs.length ? 'ready' : 'no-ports';
    this.onChange();
  }

  /* ------------------------------------------------------------------ time */

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

  /** The other way, for messages arriving stamped in the MIDI domain. */
  toAudioTime(midiTime) {
    if (this.timeOffset === null) this.syncTime();
    return (midiTime - this.timeOffset) / 1000;
  }

  /* -------------------------------------------------------------- sending */

  /** Put bytes on one slot's device, counted but never refused. */
  raw(slot, bytes, at) {
    const out = this.portFor(slot);
    if (!out) return;
    this.rates.get(slot)?.add(this.clock.now(), bytes.length);
    try {
      out.send(bytes, this.toMidiTime(at));
    } catch {
      /* port closed mid-send */
    }
  }

  /**
   * Clock and transport messages go to every slot set to receive them, past the
   * note throttle.
   *
   * Dropping one is worse than sending it late: a missing clock pulse reads as
   * a tempo stumble at the far end, and a missing Stop leaves the receiver
   * running. Their rate is bounded by the tempo anyway — 24 per quarter note is
   * 120 a second even at 300bpm — so they cannot be the thing that floods a
   * port. They still count towards the meter, so notes give way before they do.
   */
  sendRealtime(bytes, at) {
    for (const slot of this.boundSlots) {
      if (this.sendsClock(slot)) this.raw(slot, bytes, at);
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

  /**
   * Schedule a note.
   *
   * The note-off is queued rather than sent, because MIDI has no concept of
   * "this note, specifically" — a note-off is just a channel and a pitch. If
   * the same pitch is retriggered on the same channel before the first one
   * ends, sending both note-offs up front means the earlier one cuts the later
   * note short, and the last one arrives with nothing sounding. Holding them
   * lets a retrigger release the previous note first instead.
   *
   * The same pitch and channel on two different devices are two different
   * notes, so the queue is keyed by slot as well.
   */
  noteOn({ slot = DEFAULT_SLOT, channel, note, velocity, at, duration }) {
    const where = asSlot(slot);
    const out = this.portFor(where);
    if (!out) return;
    const ch = clamp(Math.round(channel), 1, 16) - 1;
    const n = clamp(Math.round(note), 0, 127);
    const v = clamp(Math.round(velocity), 1, 127);
    const key = `${where}:${ch}:${n}`;
    const end = at + Math.max(0.01, duration);

    // Throttle note-ons only. Dropping a note-off would leave a note sounding
    // on the receiving instrument with nothing left to release it. Each device
    // gets its own budget, since each has its own bandwidth.
    const now = this.clock.now();
    const rate = this.rates.get(where);
    if (rate.rate(now) >= LIMITS.midiPerSecond) {
      this.governor?.trip('midi', now, `notes dropped on output ${where}`);
      return;
    }
    rate.add(now, 2); // this note-on and the note-off it will need

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
    this.pendingOffs.push({ key, slot: where, ch, note: n, start: at, time: end, done: false });
  }

  /**
   * A control change.
   *
   * Repeats are dropped. A modulator stepping through a sequence or drifting
   * within a range lands on the same value often, and a controller that has not
   * moved is worth no bytes at all — CC is the usual reason a MIDI cable is
   * saturated.
   *
   * Unlike a note-off, a CC may be thrown away under load: a dropped one leaves
   * a value briefly stale, where a dropped note-off leaves a note sounding for
   * good. So this goes through the same throttle as note-ons.
   *
   * @returns {boolean} whether anything was sent
   */
  sendControl({ slot = DEFAULT_SLOT, channel, controller, value, at }) {
    const where = asSlot(slot);
    const out = this.portFor(where);
    if (!out) return false;
    const ch = clamp(Math.round(channel), 1, 16) - 1;
    const cc = clamp(Math.round(controller), 0, 127);
    const v = clamp(Math.round(value), 0, 127);

    const key = `${where}:${ch}:${cc}`;
    if (this.lastControl.get(key) === v) return false;

    const now = this.clock.now();
    const rate = this.rates.get(where);
    if (rate.rate(now) >= LIMITS.midiPerSecond) {
      this.governor?.trip('midi', now, `controllers dropped on output ${where}`);
      return false;
    }
    rate.add(now, 1);

    try {
      out.send([0xb0 | ch, cc, v], this.toMidiTime(at));
    } catch {
      return false; // port closed mid-send
    }
    this.lastControl.set(key, v);
    return true;
  }

  /**
   * Choose the sound a channel plays.
   *
   * Never throttled and never deduplicated: a program change is rare, and it
   * is the message that decides whether anything afterwards sounds like what
   * it was written for. Sending one that the device already has costs nothing.
   *
   * @returns {boolean} whether it reached a device
   */
  sendProgram({ slot = DEFAULT_SLOT, channel, program, at }) {
    const out = this.portFor(asSlot(slot));
    if (!out) return false;
    const ch = clamp(Math.round(channel), 1, 16) - 1;
    const value = clamp(Math.round(program), 0, 127);
    try {
      out.send([0xc0 | ch, value], this.toMidiTime(at));
    } catch {
      return false; // port closed mid-send
    }
    return true;
  }

  /** Hand one queued note-off to its device, optionally earlier than planned. */
  sendOff(off, at = off.time) {
    if (off.done) return;
    off.done = true;
    this.sounding.delete(off.key);
    const out = this.portFor(off.slot);
    if (!out) return;
    try {
      out.send([0x80 | off.ch, off.note, 0], this.toMidiTime(at));
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

  /* --------------------------------------------------------------- panic */

  /** Cancel anything pending on one device and silence every channel on it. */
  silence(slot) {
    const out = this.portFor(slot);
    if (!out) return;
    try {
      if (typeof out.clear === 'function') out.clear();
      for (const key of [...this.sounding]) {
        const [where, ch, n] = key.split(':');
        if (where !== slot) continue;
        out.send([0x80 | Number(ch), Number(n), 0]);
        this.sounding.delete(key);
      }
      for (let ch = 0; ch < 16; ch += 1) {
        out.send([0xb0 | ch, 123, 0]); // all notes off
        out.send([0xb0 | ch, 120, 0]); // all sound off
      }
    } catch {
      /* ignore */
    }
    this.pendingOffs = this.pendingOffs.filter((off) => off.slot !== slot);
    // The device's controllers are no longer where we left them, so the next
    // send must go out even if the value looks unchanged.
    for (const key of [...this.lastControl.keys()]) {
      if (key.startsWith(`${slot}:`)) this.lastControl.delete(key);
    }
  }

  /** Silence every device. */
  allOff() {
    for (const slot of this.boundSlots) this.silence(slot);
    this.sounding.clear();
    this.pendingOffs.length = 0;
  }
}
