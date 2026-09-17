// Guard rails.
//
// Gridi is a MIDI sequencer. Everything here exists to stop a patch from
// flooding the thing it is driving, or from burning the machine it runs on.
// The numbers are deliberately generous: they are not a budget to compose
// within, they are the point past which something has gone wrong.
//
// The worst case is not subtle. A splitter wired back into itself turns one
// pulse into two, those into four, and so on; measured before these limits, a
// four-node patch of that shape sent 143,813 MIDI messages per second, which no
// port or DAW can absorb.

export const LIMITS = {
  /** Events the scheduler will process in a single tick, so one tick cannot hang. */
  eventsPerTick: 2000,
  /** Sustained event rate past which a patch is considered to have run away. */
  eventsPerSecond: 8000,
  /** MIDI messages per second handed to the port. DIN MIDI carries about 1000. */
  midiPerSecond: 2000,
  /** Sounding Web Audio voices across the whole patch. */
  voices: 64,
  /** Nodes and lines a patch may contain. */
  nodes: 400,
  lines: 800,
  /** Travelling pulses drawn at once. */
  visualPulses: 900,
  /** Repeated overloads within this window before the transport is stopped. */
  escalateAfter: 3,
  escalateWithin: 6,
};

/** The line that belongs on every one of these, because it is the real answer. */
export const SCOPE_NOTE =
  'Gridi is built to send MIDI, not to be an audio engine. The built-in voices '
  + 'are for sketching a patch, not for performing it — for heavy synthesis, drive '
  + 'a DAW or a hardware instrument over MIDI, where it will run far better.';

export const GUARDS = {
  events: {
    title: 'Pulse storm stopped',
    detail:
      'The patch was generating more pulses than the scheduler can carry, which '
      + 'usually means a line loops back on itself. Pulses still in flight were dropped.',
  },
  midi: {
    title: 'MIDI output throttled',
    detail:
      'More messages were queued than a MIDI port can carry, so the surplus was '
      + 'dropped rather than flooding the receiving instrument.',
  },
  voices: {
    title: 'Voice limit reached',
    detail:
      'More notes were sounding at once than the built-in synth will hold, so the '
      + 'oldest were released early.',
  },
  patch: {
    title: 'Patch too large',
    detail: 'This patch is past the size Gridi will hold, so the remainder was left out.',
  },
};

/**
 * Counts events over a sliding second, in tenth-of-a-second buckets. Cheap
 * enough to call on every scheduled event.
 */
export class RateMeter {
  constructor(windowSec = 1, buckets = 10) {
    this.windowSec = windowSec;
    this.buckets = new Array(buckets).fill(0);
    this.stamps = new Array(buckets).fill(-Infinity);
    this.slot = windowSec / buckets;
  }

  add(now, n = 1) {
    const index = Math.floor(now / this.slot) % this.buckets.length;
    const stamp = Math.floor(now / this.slot);
    if (this.stamps[index] !== stamp) {
      this.stamps[index] = stamp;
      this.buckets[index] = 0;
    }
    this.buckets[index] += n;
  }

  /** Events in the last window, expressed per second. */
  rate(now) {
    const current = Math.floor(now / this.slot);
    let total = 0;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (current - this.stamps[i] < this.buckets.length) total += this.buckets[i];
    }
    return total / this.windowSec;
  }

  reset() {
    this.buckets.fill(0);
    this.stamps.fill(-Infinity);
  }
}

/**
 * Collects limit breaches and passes them on, without repeating itself. A
 * runaway patch trips its limit thousands of times a second; the person needs
 * telling once.
 */
export class Governor {
  constructor(onTrip = () => {}, { quietFor = 4 } = {}) {
    this.onTrip = onTrip;
    this.quietFor = quietFor;
    this.lastTold = new Map();
    this.history = [];
  }

  /**
   * @returns {boolean} whether this breach was passed on (rather than folded
   * into one already reported).
   */
  trip(kind, now, detail = '') {
    this.history.push({ kind, now });
    const cutoff = now - LIMITS.escalateWithin;
    while (this.history.length && this.history[0].now < cutoff) this.history.shift();

    const told = this.lastTold.get(kind);
    if (told !== undefined && now - told < this.quietFor) return false;
    this.lastTold.set(kind, now);
    // The spread goes first so a caller's specific note is not overwritten by
    // the generic wording.
    this.onTrip({ ...GUARDS[kind], kind, note: detail, repeats: this.count(kind, now) });
    return true;
  }

  /** How many times this kind has tripped inside the escalation window. */
  count(kind, now) {
    const cutoff = now - LIMITS.escalateWithin;
    return this.history.filter((h) => h.kind === kind && h.now >= cutoff).length;
  }

  /** Has this kind tripped often enough that carrying on is pointless? */
  shouldEscalate(kind, now) {
    return this.count(kind, now) >= LIMITS.escalateAfter;
  }

  reset() {
    this.lastTold.clear();
    this.history.length = 0;
  }
}
