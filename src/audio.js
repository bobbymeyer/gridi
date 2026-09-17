// Web Audio back end: the built-in voices, and the clock everything else runs on.
//
// Web Audio and Web MIDI are separate APIs doing separate jobs here. This file
// makes sound; midi.js sends messages. They only share a sense of time.

import { clamp } from './util.js';
import {
  adsrPoints, filterPoints, envelopeEnd, oscHz, oscMix, midiToHz, isWaveform, SILENCE,
} from './voice.js';

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
  }

  filter.connect(amp);
  amp.connect(destination);
  return { oscillators, stopAt };
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.limiter = null;
    this.volume = 0.8;
    this.live = new Set(); // scheduled sources, so panic can stop them
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
  register(node) {
    this.live.add(node);
    node.onended = () => this.live.delete(node);
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
   * The audition tone for Note nodes: a short pitched blip so a patch is
   * audible with no MIDI hardware attached, which is most of the time.
   */
  blip(midiNote, velocity, at, dur) {
    if (!this.ctx) return;
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

  /** Two-oscillator subtractive voice. The graph itself is built by buildVoice. */
  voice(params, midiNote, velocity, at, dur) {
    if (!this.ctx) return;
    const t = Math.max(at, this.now());
    const { oscillators } = buildVoice(this.ctx, this.master, params, midiNote, velocity, t, dur);
    for (const osc of oscillators) this.register(osc);
  }

  /** Stop everything already scheduled. Used by transport stop and panic. */
  allOff() {
    const t = this.now();
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
