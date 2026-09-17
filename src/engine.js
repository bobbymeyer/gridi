// The pulse engine: a look-ahead scheduler plus graph propagation.
//
// Two clocks are in play. Audio time (AudioContext seconds) is what everything
// is scheduled against, because it is sample-accurate and does not drift when
// the main thread stalls. Wall time only drives the animation.
//
// Each tick we look a short way into the future, work out which emitters fire
// in that window, walk the graph from each of them, and hand absolute times to
// the audio and MIDI back ends. Nothing is fired "now" -- by the time you hear
// it, it was scheduled 100ms ago.

import { EventQueue, clamp, rng, wrap } from './util.js';
import { resolveDegree, SCALES } from './music.js';
import { stepBeats, stepOnsetBeats, emitterFiresOn, beatsToSeconds } from './rhythm.js';
import { outgoing, incoming, nodeById } from './model.js';
import { MODULATABLE, NODE_TYPES } from './nodes.js';
import { LIMITS, RateMeter } from './limits.js';
import { PPQN, DEFAULT_SLOT } from './midi.js';

export const LOOKAHEAD = 0.14; // seconds of future we schedule each tick
export const TICK_MS = 25;
const MAX_HOPS = 64; // feedback loops are allowed, but they have to end

/** Parses "0:minPent 5:major" into [{root, scale}, ...]. */
export function parseKeySteps(text) {
  const out = [];
  for (const token of String(text || '').trim().split(/[\s,]+/)) {
    if (!token) continue;
    const [rootPart, scalePart] = token.split(':');
    const root = clamp(Math.round(Number(rootPart) || 0), 0, 11);
    const scale = SCALES[scalePart] ? scalePart : 'minPent';
    out.push({ root, scale });
  }
  return out.length ? out : [{ root: 0, scale: 'minPent' }];
}

/** Parses "1 3 5 7" into numbers. */
export function parseValues(text) {
  const out = String(text || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  return out.length ? out : [0];
}

function paramSpec(type, key) {
  const specs = NODE_TYPES[type]?.params ?? [];
  return specs.find((s) => s.key === key);
}

export class Engine {
  /**
   * @param {object} io
   * @param {() => object} io.getPatch  current patch document
   * @param {object} io.audio  { now(), blip(), voice(), allOff() }
   * @param {object} io.midi   { noteOn(), noteOff(), allOff() }
   * @param {(evt: object) => void} [io.onPulse]  visual pulse travelling a line
   * @param {(evt: object) => void} [io.onFire]   a node produced sound
   */
  constructor({ getPatch, audio, midi, onPulse, onFire, governor, onOverload }) {
    this.getPatch = getPatch;
    this.audio = audio;
    this.midi = midi;
    this.onPulse = onPulse ?? (() => {});
    this.onFire = onFire ?? (() => {});
    this.governor = governor ?? null;
    this.onOverload = onOverload ?? (() => {});
    this.eventRate = new RateMeter();
    this.clockPulse = 0; // index of the next clock pulse to schedule
    this.clockOn = false; // whether clock was being sent as of the last tick

    this.running = false;
    this.queue = new EventQueue();
    this.runtime = new Map(); // nodeId -> per-node mutable state
    this.buckets = new Map(); // logic-gate coincidence windows
    this.emitters = new Map(); // nodeId -> { step, scheduledBeat }
    this.random = rng(1);

    // Beat anchor. Changing BPM re-anchors here rather than rewinding the song.
    this.anchorTime = 0;
    this.anchorBeat = 0;
    this.bpm = 120;
  }

  /* -------------------------------------------------------------- transport */

  start() {
    if (this.running) return;
    const patch = this.getPatch();
    this.random = rng(patch.seed || 1);
    this.queue.clear();
    this.runtime.clear();
    this.buckets.clear();
    this.emitters.clear();
    this.bpm = patch.bpm;
    this.eventRate.reset();
    this.anchorTime = this.audio.now() + 0.08; // a beat of slack before bar one
    this.anchorBeat = 0;
    this.running = true;

    // Tell the rig we are starting before the first pulse of clock reaches it.
    this.clockPulse = 0;
    this.clockOn = Boolean(patch.clockOut);
    if (this.clockOn) {
      this.midi.sendSongPosition(0, this.anchorTime - 0.002);
      this.midi.sendStart(this.anchorTime - 0.001);
    }
    this.tick();
  }

  stop() {
    if (this.clockOn) this.midi.sendStop(this.audio.now());
    this.clockOn = false;
    this.running = false;
    this.queue.clear();
    this.buckets.clear();
    this.emitters.clear();
    this.midi.allOff();
    this.audio.allOff();
  }

  /** Re-anchor so a tempo change takes effect from here, not from bar one. */
  setBpm(bpm) {
    const next = clamp(Number(bpm) || 120, 20, 300);
    if (this.running) {
      const now = this.audio.now();
      this.anchorBeat = this.timeToBeat(now);
      this.anchorTime = now;
    }
    this.bpm = next;
  }

  beatToTime(beat) {
    return this.anchorTime + ((beat - this.anchorBeat) * 60) / this.bpm;
  }

  timeToBeat(time) {
    return this.anchorBeat + ((time - this.anchorTime) * this.bpm) / 60;
  }

  /** Musical position, for the transport readout. */
  position() {
    if (!this.running) return { bar: 1, beat: 1, beats: 0 };
    const beats = Math.max(0, this.timeToBeat(this.audio.now()));
    return {
      beats,
      bar: Math.floor(beats / 4) + 1,
      beat: Math.floor(beats % 4) + 1,
    };
  }

  /* ------------------------------------------------------------ scheduling */

  tick() {
    if (!this.running) return;
    const patch = this.getPatch();
    if (patch.bpm !== this.bpm) this.setBpm(patch.bpm);

    const now = this.audio.now();
    const horizon = now + LOOKAHEAD;

    this.scheduleClock(patch, horizon, now);
    this.scheduleEmitters(patch, horizon);
    const processed = this.drain(patch, horizon);
    this.eventRate.add(now, processed);
    if (this.eventRate.rate(now) > LIMITS.eventsPerSecond) this.runaway(now);
    this.sweepBuckets(now);
    // Note-offs are held until they are nearly due, so a retriggered note can
    // still be released first. This is the tick that lets them go.
    if (typeof this.midi.flush === 'function') this.midi.flush(now);
  }

  /**
   * MIDI clock: 24 pulses per quarter note, on the same beat grid as the
   * pulses, so a tempo change moves both together.
   *
   * Turning it on mid-song resumes properly rather than replaying the clock
   * from bar one — song position, then Continue, which is what the messages
   * are for.
   */
  scheduleClock(patch, horizon, now) {
    const wanted = Boolean(patch.clockOut);
    if (wanted !== this.clockOn) {
      if (wanted) {
        const beat = Math.max(0, this.timeToBeat(now));
        this.clockPulse = Math.ceil(beat * PPQN);
        this.midi.sendSongPosition(Math.floor(beat * 4), now);
        this.midi.sendContinue(now);
      } else {
        this.midi.sendStop(now);
      }
      this.clockOn = wanted;
    }
    if (!this.clockOn) return;

    // Bounded by tempo: 24 pulses a quarter note is 120 a second at 300bpm.
    for (let guard = 0; guard < 512; guard += 1) {
      const time = this.beatToTime(this.clockPulse / PPQN);
      if (time > horizon) break;
      this.midi.sendClock(Math.max(time, now));
      this.clockPulse += 1;
    }
  }

  scheduleEmitters(patch, horizon) {
    for (const node of patch.nodes) {
      if (node.type !== 'pulse') continue;
      let state = this.emitters.get(node.id);
      if (!state) {
        // Join the grid on the next whole step so late-added emitters lock in.
        const beats = stepBeats(node.params.division, node.params.ratioNum, node.params.ratioDen);
        const nowBeat = Math.max(0, this.timeToBeat(this.audio.now()));
        state = { step: Math.ceil(nowBeat / beats) };
        this.emitters.set(node.id, state);
      }
      if (!node.params.running) continue;

      let guard = 0;
      for (;;) {
        const beats = stepBeats(node.params.division, node.params.ratioNum, node.params.ratioDen);
        const onset = stepOnsetBeats(state.step, beats, node.params.swing);
        const time = this.beatToTime(onset);
        if (time > horizon || guard > 512) break;
        guard += 1;

        if (emitterFiresOn(state.step, node.params)) {
          const jitter = node.params.humanize
            ? ((this.random() * 2 - 1) * node.params.humanize) / 1000
            : 0;
          const at = Math.max(time + jitter, this.audio.now() + 0.001);
          this.queue.push({ time: at, kind: 'emit', nodeId: node.id, step: state.step });
        }
        state.step += 1;
      }
    }
  }

  /**
   * Process every queued event up to the horizon, in time order. The per-tick
   * ceiling means one tick cannot hang the page, whatever the patch does.
   *
   * @returns {number} how many events were handled
   */
  drain(patch, horizon) {
    let processed = 0;
    while (this.queue.size > 0 && processed < LIMITS.eventsPerTick) {
      const next = this.queue.items[0];
      if (next.time > horizon) break;
      const evt = this.queue.pop();
      processed += 1;
      if (evt.kind === 'emit') this.handleEmit(patch, evt);
      else if (evt.kind === 'arrive') this.handleArrive(patch, evt);
      else if (evt.kind === 'gate') this.handleGateWindow(patch, evt);
    }
    return processed;
  }

  /**
   * A patch producing more pulses than the scheduler can carry -- almost always
   * a line looping back on itself. Capping the work per tick alone would leave
   * it running at the ceiling forever, so the in-flight pulses go, and if it
   * keeps happening the transport stops rather than pretending to cope.
   */
  runaway(now) {
    const dropped = this.queue.size;
    this.queue.clear();
    this.buckets.clear();
    this.eventRate.reset();
    this.midi.allOff();
    this.governor?.trip('events', now, `${dropped} pulses dropped`);
    if (this.governor?.shouldEscalate('events', now)) this.onOverload({ stop: true });
  }

  /* ----------------------------------------------------------- pulse context */

  /**
   * The packet a pulse carries. Channels, key and scale ride *with* the pulse,
   * which is what lets a line or an upstream node rewrite them mid-flight.
   */
  initialContext(patch, node) {
    const fromProject = node.params.scaleMode !== 'set';
    return {
      channels: [{ out: DEFAULT_SLOT, ch: clamp(node.params.channel, 1, 16), transpose: 0, velocity: null }],
      scale: fromProject ? patch.scale : node.params.scale,
      root: fromProject ? patch.root : node.params.root,
      velocity: node.params.velocity,
      transpose: 0,
      degreeShift: 0,
      origin: node.id,
    };
  }

  /** A line's own assignments override whatever the pulse arrived with. */
  applyLine(ctx, line) {
    const next = { ...ctx };
    if (line.channelMode === 'set' && line.channels.length) {
      next.channels = line.channels.map((c) => ({ ...c }));
    }
    if (line.scaleMode === 'set') {
      next.scale = line.scale;
      next.root = line.root;
    }
    return next;
  }

  state(nodeId, init) {
    let s = this.runtime.get(nodeId);
    if (!s) {
      s = { ...init };
      this.runtime.set(nodeId, s);
    }
    return s;
  }

  /* ------------------------------------------------------------- dispatch */

  handleEmit(patch, evt) {
    const node = nodeById(patch, evt.nodeId);
    if (!node) return;
    const ctx = this.initialContext(patch, node);
    this.onFire({ nodeId: node.id, time: evt.time, kind: 'pulse' });
    this.send(patch, node.id, ctx, evt.time, 0);
  }

  /** Push a pulse down every outgoing line, applying each line's own state. */
  send(patch, nodeId, ctx, time, hops, stagger = 0) {
    if (hops > MAX_HOPS) return;
    const lines = outgoing(patch, nodeId);
    lines.forEach((line, i) => {
      if (line.muted) return;
      const delay = beatsToSeconds(line.delay + stagger * i, this.bpm);
      const arrive = time + delay;
      const next = this.applyLine(ctx, line);
      this.queue.push({ time: arrive, kind: 'arrive', nodeId: line.to, lineId: line.id, ctx: next, hops: hops + 1 });
      // Visual travel is decoupled: the dot lands exactly when the sound does.
      this.onPulse({ lineId: line.id, fromTime: time, arriveTime: arrive, fromNode: nodeId, toNode: line.to });
    });
  }

  handleArrive(patch, evt) {
    const node = nodeById(patch, evt.nodeId);
    if (!node) return;
    const handler = this[`on_${node.type}`];
    if (handler) handler.call(this, patch, node, evt);
  }

  on_split(patch, node, evt) {
    this.onFire({ nodeId: node.id, time: evt.time, kind: 'thru' });
    this.send(patch, node.id, evt.ctx, evt.time, evt.hops, node.params.stagger);
  }

  on_chance(patch, node, evt) {
    const s = this.state(node.id, { bias: 0 });
    const p = clamp(node.params.probability + (node.params.mode === 'drunk' ? s.bias : 0), 0, 100);
    const pass = this.random() * 100 < p;
    if (node.params.mode === 'drunk') {
      s.bias = clamp(pass ? s.bias - 12 : s.bias + 12, -45, 45);
    }
    this.onFire({ nodeId: node.id, time: evt.time, kind: pass ? 'pass' : 'block' });
    if (pass) this.send(patch, node.id, evt.ctx, evt.time, evt.hops);
  }

  on_router(patch, node, evt) {
    const lines = outgoing(patch, node.id).filter((l) => !l.muted);
    if (!lines.length) return;
    const s = this.state(node.id, { index: 0, dir: 1, last: -1 });
    let pick = 0;
    if (node.params.mode === 'cycle') {
      pick = wrap(s.index, lines.length);
      s.index = wrap(s.index + 1, lines.length);
    } else if (node.params.mode === 'pingpong') {
      pick = clamp(s.index, 0, lines.length - 1);
      if (lines.length > 1) {
        if (s.index + s.dir >= lines.length || s.index + s.dir < 0) s.dir *= -1;
        s.index = clamp(s.index + s.dir, 0, lines.length - 1);
      }
    } else if (node.params.mode === 'shuffle' && lines.length > 1) {
      do {
        pick = Math.floor(this.random() * lines.length);
      } while (pick === s.last);
    } else {
      pick = Math.floor(this.random() * lines.length);
    }
    s.last = pick;

    const line = lines[pick];
    const arrive = evt.time + beatsToSeconds(line.delay, this.bpm);
    const next = this.applyLine(evt.ctx, line);
    this.queue.push({ time: arrive, kind: 'arrive', nodeId: line.to, lineId: line.id, ctx: next, hops: evt.hops + 1 });
    this.onPulse({ lineId: line.id, fromTime: evt.time, arriveTime: arrive, fromNode: node.id, toNode: line.to });
    this.onFire({ nodeId: node.id, time: evt.time, kind: 'thru' });
  }

  /**
   * Coincidence detection. Arrivals are collected into a window; the window is
   * evaluated when it closes, but fires at its *first* arrival time so the gate
   * does not drag behind the beat.
   */
  on_gate(patch, node, evt) {
    if (node.params.mode === 'any') {
      this.onFire({ nodeId: node.id, time: evt.time, kind: 'pass' });
      this.send(patch, node.id, evt.ctx, evt.time, evt.hops);
      return;
    }
    const windowSec = Math.max(0.001, node.params.windowMs / 1000);
    const slot = Math.floor(evt.time / windowSec);
    const key = `${node.id}:${slot}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { nodeId: node.id, firstTime: evt.time, lines: new Set(), ctx: evt.ctx, hops: evt.hops, closed: false };
      this.buckets.set(key, bucket);
      this.queue.push({ time: (slot + 1) * windowSec, kind: 'gate', key });
    }
    bucket.lines.add(evt.lineId);
    bucket.firstTime = Math.min(bucket.firstTime, evt.time);
    bucket.hops = Math.max(bucket.hops, evt.hops);
  }

  handleGateWindow(patch, evt) {
    const bucket = this.buckets.get(evt.key);
    if (!bucket || bucket.closed) return;
    bucket.closed = true;
    const node = nodeById(patch, bucket.nodeId);
    if (!node) return;

    const arrived = bucket.lines.size;
    const feeding = incoming(patch, node.id).filter((l) => !l.muted).length;
    let open = false;
    if (node.params.mode === 'all') open = feeding > 0 && arrived >= feeding;
    else if (node.params.mode === 'count') open = arrived >= node.params.count;
    else if (node.params.mode === 'xor') open = arrived === 1;

    this.onFire({ nodeId: node.id, time: bucket.firstTime, kind: open ? 'pass' : 'block' });
    if (!open) return;
    const at = Math.max(bucket.firstTime, this.audio.now() + 0.004);
    this.send(patch, node.id, bucket.ctx, at, bucket.hops);
  }

  on_key(patch, node, evt) {
    const ctx = { ...evt.ctx };
    let target;
    if (node.params.mode === 'set') {
      target = { root: node.params.root, scale: node.params.scale };
    } else {
      const steps = parseKeySteps(node.params.steps);
      const s = this.state(node.id, { index: 0 });
      if (node.params.mode === 'random') {
        target = steps[Math.floor(this.random() * steps.length)];
      } else {
        target = steps[wrap(s.index, steps.length)];
        s.index = wrap(s.index + 1, steps.length);
      }
    }
    ctx.root = target.root;
    ctx.scale = target.scale;
    ctx.transpose += node.params.transpose;
    if (node.params.latch) {
      // Latching writes the project key, so the whole patch modulates and stays.
      patch.root = target.root;
      patch.scale = target.scale;
    }
    this.onFire({ nodeId: node.id, time: evt.time, kind: 'key', root: target.root, scale: target.scale });
    this.send(patch, node.id, ctx, evt.time, evt.hops);
  }

  on_param(patch, node, evt) {
    const ctx = { ...evt.ctx };
    const s = this.state(node.id, { index: 0, current: null });
    const key = node.params.param;

    const readCurrent = () => {
      if (node.params.scope === 'signal') return ctx[key] ?? 0;
      const target = nodeById(patch, node.params.target);
      return target ? Number(target.params[key]) || 0 : 0;
    };

    let lo = Number(node.params.min);
    let hi = Number(node.params.max);
    if (node.params.scope === 'node') {
      const spec = paramSpec(nodeById(patch, node.params.target)?.type, key);
      if (spec && Number.isFinite(spec.min)) lo = Math.max(lo, spec.min);
      if (spec && Number.isFinite(spec.max)) hi = Math.min(hi, spec.max);
    }
    if (!Number.isFinite(lo)) lo = 0;
    if (!Number.isFinite(hi)) hi = 127;
    if (hi < lo) [lo, hi] = [hi, lo];

    let value;
    if (node.params.mode === 'sequence') {
      const values = parseValues(node.params.values);
      value = values[wrap(s.index, values.length)];
      s.index = wrap(s.index + 1, values.length);
    } else if (node.params.mode === 'random') {
      value = lo + this.random() * (hi - lo);
    } else if (node.params.mode === 'walk') {
      const step = (this.random() < 0.5 ? -1 : 1) * node.params.amount;
      value = clamp(readCurrent() + step, lo, hi);
    } else {
      const span = hi - lo;
      const raw = readCurrent() + node.params.amount;
      value = span > 0 ? lo + wrap(raw - lo, span + 1) : lo;
    }

    if (key) {
      if (node.params.scope === 'signal') {
        ctx[key] = key === 'velocity' ? clamp(Math.round(value), 1, 127) : Math.round(value);
      } else {
        const target = nodeById(patch, node.params.target);
        if (target && (MODULATABLE[target.type] ?? []).includes(key)) {
          const spec = paramSpec(target.type, key);
          const stepSize = spec?.step ?? 1;
          target.params[key] = stepSize >= 1 ? Math.round(value) : value;
        }
      }
    }
    this.onFire({ nodeId: node.id, time: evt.time, kind: 'param', value });
    this.send(patch, node.id, ctx, evt.time, evt.hops);
  }

  on_note(patch, node, evt) {
    const ctx = evt.ctx;
    const base = resolveDegree(
      node.params.degree + (ctx.degreeShift || 0),
      ctx.scale,
      ctx.root,
      node.params.octave,
      node.params.degreeMode,
    );
    const lengthSec = beatsToSeconds(node.params.length, this.bpm);
    const ratchet = Math.max(1, Math.round(node.params.ratchet));
    const slice = lengthSec / ratchet;
    const played = [];

    for (const chan of ctx.channels) {
      const midiNote = clamp(Math.round(base + (ctx.transpose || 0) + (chan.transpose || 0)), 0, 127);
      const vel = clamp(
        Math.round(node.params.velocity > 0 ? node.params.velocity : chan.velocity ?? ctx.velocity),
        1,
        127,
      );
      for (let r = 0; r < ratchet; r += 1) {
        const at = evt.time + r * slice;
        const dur = slice * 0.92;
        if (node.params.midiOn) {
          this.midi.noteOn({
            slot: chan.out,
            channel: chan.ch,
            note: midiNote,
            velocity: vel,
            at,
            duration: dur,
          });
        }
        if (node.params.audition) this.audio.blip(midiNote, vel, at, dur);
      }
      played.push({ out: chan.out, ch: chan.ch, note: midiNote, vel });
    }
    this.onFire({ nodeId: node.id, time: evt.time, kind: 'note', notes: played });
    this.send(patch, node.id, ctx, evt.time, evt.hops);
  }

  on_synth(patch, node, evt) {
    const ctx = evt.ctx;
    const midiNote = clamp(
      Math.round(
        resolveDegree(
          node.params.degree + (ctx.degreeShift || 0),
          ctx.scale,
          ctx.root,
          node.params.octave,
          node.params.degreeMode,
        ) + (ctx.transpose || 0),
      ),
      0,
      127,
    );
    const vel = clamp(Math.round(ctx.velocity), 1, 127);
    const dur = beatsToSeconds(node.params.length, this.bpm);
    this.audio.voice(node.params, midiNote, vel, evt.time, dur, node.id);
    this.onFire({ nodeId: node.id, time: evt.time, kind: 'note', notes: [{ ch: 0, note: midiNote, vel }] });
    this.send(patch, node.id, ctx, evt.time, evt.hops);
  }

  /** Drop coincidence windows that are safely in the past. */
  sweepBuckets(now) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.closed || bucket.firstTime < now - 1) this.buckets.delete(key);
    }
  }
}
