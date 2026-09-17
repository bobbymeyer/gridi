// Web Audio back end: the built-in voices, and the clock everything else runs on.
//
// Web Audio and Web MIDI are separate APIs doing separate jobs here. This file
// makes sound; midi.js sends messages. They only share a sense of time.

import { clamp } from './util.js';

const midiToHz = (note) => 440 * 2 ** ((note - 69) / 12);

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

  track(node, stopAt) {
    this.live.add(node);
    node.onended = () => this.live.delete(node);
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

  /** Subtractive voice for Voice nodes: two detuned oscillators into a filter. */
  voice(params, midiNote, velocity, at, dur) {
    if (!this.ctx) return;
    const t = Math.max(at, this.now());
    const freq = midiToHz(midiNote);
    const amp = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    filter.type = 'lowpass';
    filter.Q.value = clamp(params.resonance, 0.0001, 24);

    const cutoff = clamp(params.cutoff, 40, 18000);
    const peakCutoff = clamp(cutoff * 3.5, 40, 18000);
    filter.frequency.setValueAtTime(cutoff, t);
    filter.frequency.linearRampToValueAtTime(peakCutoff, t + params.attack);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(cutoff, 40),
      t + params.attack + params.decay,
    );

    const level = clamp(params.level, 0, 1) * (velocity / 127);
    const sustainLevel = Math.max(level * clamp(params.sustain, 0, 1), 0.0001);
    const hold = Math.max(dur, params.attack + 0.01);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), t + params.attack);
    amp.gain.exponentialRampToValueAtTime(sustainLevel, t + params.attack + params.decay);
    amp.gain.setValueAtTime(sustainLevel, t + hold);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + hold + params.release);

    const stopAt = t + hold + params.release + 0.05;
    for (const detune of [-params.detune, params.detune]) {
      const osc = this.ctx.createOscillator();
      osc.type = params.waveform;
      osc.frequency.setValueAtTime(freq, t);
      osc.detune.setValueAtTime(detune, t);
      osc.connect(filter);
      osc.start(t);
      this.track(osc, stopAt);
    }

    filter.connect(amp);
    amp.connect(this.master);
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
