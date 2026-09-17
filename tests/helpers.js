// Shared fakes. They implement the whole interface the engine expects, so a
// method added to the real back end shows up here as a failure rather than as
// silently untested behaviour.

/** Records everything the engine asks the MIDI output to send. */
export function fakeMidi() {
  return {
    notes: [],
    messages: [],
    noteOn(channel, note, velocity, at, duration) {
      this.notes.push({ ch: channel, note, vel: velocity, at, duration });
    },
    noteOff() {},
    allOff() { this.messages.push({ type: 'allOff' }); },
    flush() {},
    sendClock(at) { this.messages.push({ type: 'clock', at }); },
    sendStart(at) { this.messages.push({ type: 'start', at }); },
    sendContinue(at) { this.messages.push({ type: 'continue', at }); },
    sendStop(at) { this.messages.push({ type: 'stop', at }); },
    sendSongPosition(position, at) { this.messages.push({ type: 'spp', position, at }); },
    of(type) { return this.messages.filter((m) => m.type === type); },
  };
}

/** A clock you drive by hand, plus a record of what was asked to sound. */
export function fakeAudio() {
  return {
    t: 0,
    blips: [],
    voices: [],
    now() { return this.t; },
    blip(note, vel, at, dur) { this.blips.push({ note, vel, at, dur }); },
    voice(params, note, vel, at, dur) { this.voices.push({ note, vel, at, dur }); },
    allOff() {},
  };
}
