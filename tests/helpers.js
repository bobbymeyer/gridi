// Shared fakes. They implement the whole interface the engine expects, so a
// method added to the real back end shows up here as a failure rather than as
// silently untested behaviour.

/** Records everything the engine asks the MIDI output to send. */
export function fakeMidi() {
  return {
    notes: [],
    messages: [],
    noteOn({ slot = 'A', channel, note, velocity, at, duration }) {
      this.notes.push({ slot, ch: channel, note, vel: velocity, at, duration });
    },
    noteOff() {},
    controls: [],
    sendControl({ slot = 'A', channel, controller, value, at }) {
      this.controls.push({ slot, ch: channel, cc: controller, value, at });
      return true;
    },
    programs: [],
    sendProgram({ slot = 'A', channel, program, at }) {
      this.programs.push({ slot, ch: channel, program, at });
      return true;
    },
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

/** A stand-in for a MIDI device, recording every byte it is handed. */
export function fakePort(name = 'port') {
  return {
    name,
    sends: [],
    cleared: 0,
    send(data, ts) { this.sends.push({ data: [...data], ts: ts ?? 0 }); },
    clear() { this.cleared += 1; },
  };
}

/**
 * A MidiOut with fake devices bound to slots.
 * `wiredMidi({ slots: { A: 'iac', B: 'drums' } })` gives ports.A and ports.B.
 */
export async function wiredMidi({ slots = { A: 'p1' }, clock } = {}) {
  const { MidiOut } = await import('../src/midi.js');
  const ports = {};
  const devices = new Map();
  for (const [slot, id] of Object.entries(slots)) {
    ports[slot] = fakePort(id);
    devices.set(id, ports[slot]);
  }
  const midi = new MidiOut(clock ?? { now: () => 0 });
  midi.access = { outputs: devices };
  midi.outputs = [...devices.keys()].map((id) => ({ id, name: id, manufacturer: '' }));
  for (const [slot, id] of Object.entries(slots)) midi.bind(slot, id);
  return { midi, ports, devices };
}

/** What a device saw, in delivery order. */
export function stream(port) {
  if (!port.sends.length) return [];
  const base = Math.min(...port.sends.map((s) => s.ts));
  return port.sends
    .map((s) => {
      const status = s.data[0] & 0xf0;
      const type = status === 0x90 ? 'on' : status === 0x80 ? 'off' : 'cc';
      return {
        type,
        ch: (s.data[0] & 0x0f) + 1,
        note: s.data[1],
        vel: s.data[2],
        at: Math.round(s.ts - base),
      };
    })
    .sort((a, b) => a.at - b.at);
}
