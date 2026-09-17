// Web MIDI input.
//
// Two jobs. Following someone else's clock, so Gridi can sit in a rig where
// something else is the master; and letting played notes into the graph, so a
// keyboard is another kind of pulse source.
//
// Incoming messages are stamped in the performance.now() domain and everything
// downstream works in AudioContext seconds, so the timebase does the conversion
// — the same one the output side uses, which keeps in and out on one clock.

import { clamp } from './util.js';
import { LIMITS, RateMeter } from './limits.js';

export const CLOCK = 0xf8;
export const START = 0xfa;
export const CONTINUE = 0xfb;
export const STOP = 0xfc;
export const SONG_POSITION = 0xf2;
export const ACTIVE_SENSING = 0xfe;

/**
 * Decode one MIDI message into something the app can act on, or null for the
 * ones it has no use for.
 *
 * Note-on with velocity zero is a note-off. Plenty of devices send it that way
 * — running status makes it cheaper — and treating it as a note-on would leave
 * a key stuck down for ever.
 */
export function decode(bytes) {
  if (!bytes || !bytes.length) return null;
  const status = bytes[0];
  switch (status) {
    case CLOCK: return { type: 'clock' };
    case START: return { type: 'start' };
    case CONTINUE: return { type: 'continue' };
    case STOP: return { type: 'stop' };
    case SONG_POSITION:
      return { type: 'position', sixteenths: (bytes[1] ?? 0) | ((bytes[2] ?? 0) << 7) };
    default: break;
  }
  const kind = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  if (kind === 0x90) {
    const velocity = bytes[2] ?? 0;
    return velocity > 0
      ? { type: 'noteOn', channel, note: bytes[1] ?? 0, velocity }
      : { type: 'noteOff', channel, note: bytes[1] ?? 0 };
  }
  if (kind === 0x80) return { type: 'noteOff', channel, note: bytes[1] ?? 0 };
  if (kind === 0xb0) {
    return { type: 'control', channel, controller: bytes[1] ?? 0, value: bytes[2] ?? 0 };
  }
  return null; // active sensing, sysex, and anything else we have no use for
}

export class MidiIn {
  /** @param {{toAudioTime: (t: number) => number, clock: {now: () => number}}} timebase */
  constructor(timebase) {
    this.timebase = timebase;
    this.access = null;
    this.inputs = [];
    this.inputId = null;
    this.onChange = () => {};
    this.governor = null;
    this.rate = new RateMeter();
    this.listening = null; // the port we have a handler on
    this.lastActivity = 0;

    // Filled in by whoever cares. Kept as plain fields so there is one obvious
    // place to look for what an incoming message does.
    this.onClock = () => {};
    this.onStart = () => {};
    this.onContinue = () => {};
    this.onStop = () => {};
    this.onPosition = () => {};
    this.onNote = () => {};
  }

  get enabled() {
    return Boolean(this.port);
  }

  get port() {
    if (!this.access || !this.inputId) return null;
    return this.access.inputs.get(this.inputId) ?? null;
  }

  deviceName() {
    return this.inputs.find((i) => i.id === this.inputId)?.name ?? null;
  }

  /** Share the MIDIAccess the output side already obtained. */
  attach(access) {
    this.access = access;
    this.refresh();
  }

  refresh() {
    if (!this.access) return;
    this.inputs = [...this.access.inputs.values()].map((i) => ({
      id: i.id,
      name: i.name || i.id,
      manufacturer: i.manufacturer || '',
    }));
    if (this.inputId && !this.inputs.some((i) => i.id === this.inputId)) this.setInput(null);
    else this.listen();
    this.onChange();
  }

  setInput(id) {
    if (this.inputId === id) return;
    this.inputId = id || null;
    this.listen();
    this.onChange();
  }

  /** Exactly one port has our handler at a time. */
  listen() {
    if (this.listening && this.listening !== this.port) {
      try {
        this.listening.onmidimessage = null;
      } catch {
        /* the port went away */
      }
    }
    this.listening = this.port;
    if (!this.listening) return;
    try {
      this.listening.onmidimessage = (event) => this.handle(event);
    } catch {
      /* the port went away */
    }
  }

  /** @param {{data: Uint8Array, timeStamp: number}} event */
  handle(event) {
    const message = decode(event?.data);
    if (!message) return;
    const at = this.timebase.toAudioTime(event.timeStamp ?? performance.now());
    this.lastActivity = this.timebase.clock.now();

    switch (message.type) {
      case 'clock': this.onClock(at); return;
      case 'start': this.onStart(at); return;
      case 'continue': this.onContinue(at); return;
      case 'stop': this.onStop(at); return;
      case 'position': this.onPosition(message.sixteenths, at); return;
      case 'noteOn': break;
      default: return; // note-offs and controllers have no destination yet
    }

    // A device stuck in a loop must not be able to inject pulses without limit.
    const now = this.timebase.clock.now();
    if (this.rate.rate(now) >= LIMITS.midiPerSecond) {
      this.governor?.trip('midi', now, 'incoming notes dropped');
      return;
    }
    this.rate.add(now, 1);
    this.onNote({
      channel: message.channel,
      note: clamp(message.note, 0, 127),
      velocity: clamp(message.velocity, 1, 127),
      at,
    });
  }

  close() {
    this.setInput(null);
  }
}
