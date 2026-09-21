// Web Audio back end: the built-in voices, and the clock everything else runs on.
//
// Web Audio and Web MIDI are separate APIs doing separate jobs here. This file
// makes sound; midi.js sends messages. They only share a sense of time.

import { clamp } from './util.js';
import {
  adsrPoints, filterPoints, envelopeEnd, oscHz, oscMix, midiToHz, isWaveform,
  stealTargets, SILENCE,
} from './voice.js';
import { LIMITS } from './limits.js';
import { buildSoundfontVoice } from './soundfont.js';
import { DRUM_CHANNEL } from './gm.js';

/** Ceiling across the whole patch, whatever the per-node limits add up to. */
export const GLOBAL_VOICE_CAP = LIMITS.voices;
/** Long enough not to click, short enough to free the voice straight away. */
const STEAL_FADE = 0.012;

/**
 * Write a breakpoint list onto an AudioParam. The first point is set outright
 * and the rest are ramped to on the curve each one names. Exponential curves
 * cannot reach or pass through zero, so silence is a very small number instead.
 */
function applyPoints(param, points, floor = SILENCE) {
  param.cancelScheduledValues(points[0].time);
  param.setValueAtTime(Math.max(points[0].value, floor), points[0].time);
  for (let i = 1; i < points.length; i += 1) {
    const { time, value, curve } = points[i];
    if (curve === 'linear') param.linearRampToValueAtTime(Math.max(value, floor), time);
    else param.exponentialRampToValueAtTime(Math.max(value, floor), time);
  }
}

/**
 * Build one voice on any context, and return its sources plus the time it goes
 * quiet. Taking the context and destination as arguments means the exact same
 * graph can be rendered offline in a test as is played live.
 *
 * Two oscillators, each with its own waveform, octave, semitone offset, fine
 * detune and level, through a resonant low-pass with its own contour, into an
 * ADSR amplifier.
 */
export function buildVoice(ctx, destination, params, midiNote, velocity, at, holdSec) {
  const env = {
    attack: params.attack,
    decay: params.decay,
    sustain: params.sustain,
    release: params.release,
  };
  const hold = Math.max(holdSec, 0.001);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = clamp(params.resonance, 0.0001, 24);
  applyPoints(filter.frequency, filterPoints(env, params.cutoff, params.filterEnv, at, hold), 20);

  const amp = ctx.createGain();
  const peak = clamp(params.level, 0, 1) * (clamp(velocity, 1, 127) / 127);
  const envelope = adsrPoints(env, peak, at, hold);
  applyPoints(amp.gain, envelope);

  const chain = [filter, amp];
  const mix = oscMix(params.aLevel, params.bLevel);
  const specs = [
    { wave: params.aWave, octave: params.aOctave, semi: params.aSemi, detune: params.aDetune, gain: mix.a },
    { wave: params.bWave, octave: params.bOctave, semi: params.bSemi, detune: params.bDetune, gain: mix.b },
  ];

  const stopAt = envelopeEnd(envelope) + 0.02;
  const oscillators = [];
  for (const spec of specs) {
    if (spec.gain <= 0) continue; // a silenced oscillator costs nothing to skip
    const osc = ctx.createOscillator();
    osc.type = isWaveform(spec.wave) ? spec.wave : 'sawtooth';
    osc.frequency.setValueAtTime(
      clamp(oscHz(midiNote, spec.octave, spec.semi), 0.01, ctx.sampleRate / 2),
      at,
    );
    osc.detune.setValueAtTime(clamp(spec.detune, -1200, 1200), at);

    const level = ctx.createGain();
    level.gain.setValueAtTime(spec.gain, at);
    osc.connect(level);
    level.connect(filter);
    osc.start(at);
    osc.stop(stopAt);
    oscillators.push(osc);
    chain.push(level);
  }

  filter.connect(amp);
  amp.connect(destination);
  // `chain` is everything downstream of the oscillators. An oscillator is
  // released once it has stopped, but the nodes it fed stay connected to the
  // output until something disconnects them, and a voice per sixteenth adds up
  // fast -- so the caller retires the chain when the voice is done.
  return { oscillators, amp, chain, stopAt };
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.limiter = null;
    this.volume = 0.8;
    this.live = new Set(); // scheduled sources, so panic can stop them
    this.voices = []; // sounding Voice-node notes, for voice stealing
    this.governor = null;
    this.soundfont = null; // a loaded SoundFont, if one has been dropped in
    this.fontVoices = []; // sounding SoundFont notes, capped the same way
  }

  /** Must be called from a user gesture. Browsers start contexts suspended. */
  async resume() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;
      this.ctx = new Ctor({ latencyHint: 'interactive' });

      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -8;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.12;

      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();

    // currentTime can still read zero here and jump once rendering actually
    // begins. Anchoring the transport to that reading puts every MIDI timestamp
    // out by the size of the jump, so wait for the clock to move first.
    for (let i = 0; i < 20 && this.ctx.currentTime === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.ctx.state === 'running';
  }

  get ready() {
    return Boolean(this.ctx) && this.ctx.state === 'running';
  }

  /** Audio time in seconds. Falls back to wall time before the context exists. */
  now() {
    return this.ctx ? this.ctx.currentTime : performance.now() / 1000;
  }

  setVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 1);
    if (this.master) this.master.gain.setTargetAtTime(this.volume, this.now(), 0.01);
  }

  /** Remember a source so panic can silence it, and forget it when it ends. */
  register(node, onEnded) {
    this.live.add(node);
    node.onended = () => {
      this.live.delete(node);
      if (onEnded) onEnded();
    };
    return node;
  }

  track(node, stopAt) {
    this.register(node);
    try {
      node.stop(stopAt);
    } catch {
      /* already stopped */
    }
  }

  /**
   * Hear a Note node without MIDI hardware attached, which is most of the time.
   *
   * With a SoundFont loaded this is the patch's own sound: the channel's
   * program picks the preset, so what Gridi plays to itself and what it asks a
   * module to play are the same instrument. Without one it is the blip below,
   * which is a click track and was never meant to be more.
   *
   * @param {object} [voiceOf] the channel and program this note is on
   */
  blip(midiNote, velocity, at, dur, voiceOf = null) {
    if (!this.ctx) return;
    if (this.soundfont && voiceOf) {
      this.playFont(midiNote, velocity, at, dur, voiceOf);
      return;
    }
    const t = Math.max(at, this.now());
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const tone = this.ctx.createBiquadFilter();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(midiToHz(midiNote), t);
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(clamp(midiToHz(midiNote) * 6, 400, 9000), t);

    const peak = (velocity / 127) * 0.22;
    const length = Math.max(0.05, Math.min(dur, 0.5));
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);

    osc.connect(tone);
    tone.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    this.track(osc, t + length + 0.05);
  }

  /**
   * Take a SoundFont, or drop the one already loaded by passing null.
   *
   * @param {import('./soundfont.js').SoundFont|null} font
   */
  useSoundfont(font) {
    this.soundfont?.release();
    this.soundfont = font ?? null;
    return this.soundfont;
  }

  /**
   * One note through the loaded SoundFont.
   *
   * A preset can layer several samples on one key, so a note is usually more
   * than one voice. They are counted against the same ceiling as everything
   * else, and the oldest go first when the patch asks for more than the page
   * can carry.
   */
  playFont(midiNote, velocity, at, dur, { channel = 1, program = 0 }) {
    const font = this.soundfont;
    const t = Math.max(at, this.now());
    const bank = channel === DRUM_CHANNEL ? 128 : 0;
    const plans = font.plansFor(bank, program, midiNote, velocity);
    if (!plans.length) return;

    if (this.fontVoices.length + plans.length > GLOBAL_VOICE_CAP) {
      this.governor?.trip('voices', t);
      const over = this.fontVoices.length + plans.length - GLOBAL_VOICE_CAP;
      for (const victim of this.fontVoices.slice(0, over)) this.stealFont(victim, t);
    }

    for (const plan of plans) {
      let built;
      try {
        built = buildSoundfontVoice(this.ctx, this.master, font, plan, velocity, t, dur);
      } catch {
        continue; // a zone the font describes but cannot actually play
      }
      const record = { amp: built.amp, source: built.source, start: t };
      this.fontVoices.push(record);
      this.register(built.source, () => {
        this.fontVoices = this.fontVoices.filter((v) => v !== record);
      });
      try {
        built.source.stop(built.stopAt);
      } catch {
        /* already stopped */
      }
    }
  }

  /** Fade a SoundFont voice out rather than cutting it, then let it go. */
  stealFont(record, now) {
    if (record.stolen) return;
    record.stolen = true;
    try {
      record.amp.gain.cancelScheduledValues(now);
      record.amp.gain.setTargetAtTime(SILENCE, now, STEAL_FADE / 3);
      record.source.stop(now + STEAL_FADE);
    } catch {
      /* already stopped */
    }
  }

  /**
   * Two-oscillator subtractive voice. The graph itself is built by buildVoice;
   * this decides whether there is room to start another one.
   */
  voice(params, midiNote, velocity, at, dur, owner = 'voice') {
    if (!this.ctx) return;
    const t = Math.max(at, this.now());
    const cap = clamp(Math.round(params.voices ?? 8), 1, 32);
    // Per-node stealing is ordinary musical behaviour; hitting the patch-wide
    // ceiling means the synth is being asked to do a job it is not here for.
    if (this.voices.length >= GLOBAL_VOICE_CAP) this.governor?.trip('voices', t);
    for (const victim of stealTargets(this.voices, owner, cap, GLOBAL_VOICE_CAP)) {
      this.steal(victim, t);
    }

    const built = buildVoice(this.ctx, this.master, params, midiNote, velocity, t, dur);
    if (!built.oscillators.length) return; // both oscillators silent: nothing was made

    const record = {
      owner,
      start: t,
      amp: built.amp,
      chain: built.chain,
      oscillators: built.oscillators,
    };
    this.voices.push(record);
    built.oscillators.forEach((osc, i) => {
      // One oscillator ending is enough to retire the voice they share.
      this.register(osc, i === 0 ? () => this.retire(record) : undefined);
    });
  }

  /** Free a finished voice: out of the allocator, and out of the audio graph. */
  retire(record) {
    this.forget(record);
    if (record.retired) return;
    record.retired = true;
    for (const node of record.chain) {
      try {
        node.disconnect();
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Fade a voice out fast and free its slot, rather than cutting it off with a
   * click. The graph itself is retired when the oscillators actually end.
   */
  steal(record, now) {
    this.forget(record);
    const t = Math.max(now, record.start);
    try {
      const gain = record.amp.gain;
      gain.cancelScheduledValues(t);
      gain.setValueAtTime(Math.max(gain.value, SILENCE), t);
      gain.exponentialRampToValueAtTime(SILENCE, t + STEAL_FADE);
    } catch {
      /* the voice was already finishing */
    }
    for (const osc of record.oscillators) {
      try {
        osc.stop(t + STEAL_FADE + 0.002);
      } catch {
        /* already stopped */
      }
    }
  }

  forget(record) {
    const i = this.voices.indexOf(record);
    if (i !== -1) this.voices.splice(i, 1);
  }

  /** Stop everything already scheduled. Used by transport stop and panic. */
  allOff() {
    this.fontVoices = [];
    const t = this.now();
    for (const record of [...this.voices]) this.retire(record);
    this.voices.length = 0;
    for (const node of [...this.live]) {
      try {
        node.stop(t);
      } catch {
        /* ignore */
      }
      this.live.delete(node);
    }
  }
}
