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
import { stepBeats, stepOnsetBeats, emitterFiresOn, beatsToSeconds, gridBeats } from './rhythm.js';
import { lineCells } from './geometry.js';
import { outgoing, incoming, nodeById } from './model.js';
import { MODULATABLE, NODE_TYPES } from './nodes.js';
import { LIMITS, RateMeter } from './limits.js';
import { PPQN, DEFAULT_SLOT } from './midi.js';
import { ClockFollower } from './sync.js';
import { lfoAt, resolutionBeats } from './lfo.js';

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
  constructor({ getPatch, audio, midi, onPulse, onFire, governor, onOverload, onExternalTransport }) {
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
    this.follower = new ClockFollower(); // used when something else is master
    this.onExternalTransport = onExternalTransport ?? (() => {});

    this.running = false;
    this.queue = new EventQueue();
    this.runtime = new Map(); // nodeId -> per-node mutable state
    this.buckets = new Map(); // logic-gate coincidence windows
    this.emitters = new Map(); // nodeId -> { step, scheduledBeat }
    this.travel = new Map(); // lineId -> cached { key, beats } travel time
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

    this.sendSounds(patch, this.anchorTime - 0.05);

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

  /**
   * Put each channel on the sound the patch asks for.
   *
   * Sent well before the anchor rather than alongside the Start, because a
   * device given a program change and a note in the same millisecond is
   * entitled to play the first note on the old sound. Fifty milliseconds is
   * nothing to wait and plenty for anything to act on.
   *
   * @returns {number} how many were sent
   */
  sendSounds(patch, at) {
    let sent = 0;
    for (const sound of patch.sounds ?? []) {
      if (this.midi.sendProgram({ slot: sound.out, channel: sound.ch, program: sound.program, at })) {
        sent += 1;
      }
    }
    return sent;
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

  /* ------------------------------------------------- following a master */

  /**
   * Bring the local grid onto the incoming clock.
   *
   * Tempo comes from the follower's median interval, and moving it re-anchors,
   * so the current beat is preserved rather than jumping. Phase is then taken
   * out a fraction at a time: correcting it fully on every pulse would jerk the
   * grid 24 times a quarter note, which is audible. Only a gross error — the
   * master relocating, or pulses lost — is worth snapping to.
   */
  followExternal(now) {
    const follower = this.follower;
    if (!follower.running) return;

    const tempo = follower.tempo;
    if (tempo !== null && Math.abs(tempo - this.bpm) > 0.05) this.setBpm(tempo);

    const { jump, delta } = follower.correctionFor(this.timeToBeat(now));
    if (jump) {
      this.anchorBeat = follower.beat;
      this.anchorTime = now;
    } else {
      this.anchorBeat += delta;
    }
  }

  externalClock(at) {
    this.follower.pulse(at);
  }

  externalStart() {
    this.follower.start(0);
    this.onExternalTransport('start');
  }

  externalContinue() {
    this.follower.resume();
    this.onExternalTransport('continue');
  }

  externalStop() {
    this.follower.stop();
    this.onExternalTransport('stop');
  }

  externalPosition(sixteenths) {
    this.follower.locate(sixteenths);
  }

  /**
   * A note played on an attached keyboard. Every Input node listening on that
   * channel emits a pulse, so a keyboard is another kind of source rather than
   * a special case bolted to the side of the graph.
   */
  externalNote({ channel, note, velocity, at }) {
    if (!this.running) return 0;
    const patch = this.getPatch();
    const when = Math.max(at, this.audio.now() + 0.002);
    let fired = 0;
    for (const node of patch.nodes) {
      if (node.type !== 'input') continue;
      const listen = Math.round(node.params.listen);
      if (listen !== 0 && listen !== channel) continue;
      const ctx = this.playedContext(patch, node, note, velocity);
      this.onFire({ nodeId: node.id, time: when, kind: 'played', note, velocity });
      this.send(patch, node.id, ctx, when, 0);
      fired += 1;
    }
    return fired;
  }

  /** The context an Input node starts a pulse with, given the note played. */
  playedContext(patch, node, note, velocity) {
    const ctx = this.initialContext(patch, node);
    if (node.params.useVelocity) ctx.velocity = clamp(Math.round(velocity), 1, 127);
    if (node.params.sets === 'key') {
      ctx.root = wrap(Math.round(note), 12);
    } else if (node.params.sets === 'transpose') {
      ctx.transpose += Math.round(note) - Math.round(node.params.base);
    }
    return ctx;
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
    const now = this.audio.now();
    if (patch.sync === 'external') this.followExternal(now);
    else if (patch.bpm !== this.bpm) this.setBpm(patch.bpm);

    const horizon = now + LOOKAHEAD;

    this.scheduleClock(patch, horizon, now);
    this.scheduleWaves(patch, horizon, now);
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

  /**
   * LFOs put a value on their lines many times a beat.
   *
   * A wave travels the same lines a pulse does and picks up the same channels
   * and key, because routing belongs to the line whatever is moving along it.
   * What it cannot do is trigger anything: at two dozen samples a beat, a wave
   * reaching a Note node would be two dozen notes. So triggering nodes ignore
   * waves, Split carries them, and a Param node is what turns one into a
   * controller or a parameter change.
   */
  scheduleWaves(patch, horizon, now) {
    for (const node of patch.nodes) {
      if (node.type !== 'lfo') continue;
      const step = resolutionBeats(node.params.resolution);
      const state = this.state(`lfo:${node.id}`, { nextBeat: null, anchor: 0 });
      if (state.nextBeat === null) {
        state.nextBeat = Math.ceil(Math.max(0, this.timeToBeat(now)) / step) * step;
      }

      for (let guard = 0; guard < 512; guard += 1) {
        const time = this.beatToTime(state.nextBeat);
        if (time > horizon) break;
        const value = lfoAt(node.params, state.nextBeat - state.anchor, this.seedFor(node.id));
        this.emitWave(patch, node, value, Math.max(time, now));
        state.nextBeat += step;
      }
    }
  }

  /** A stable seed per node, so two random LFOs do not move together. */
  seedFor(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i += 1) {
      h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    }
    return (h >>> 0) % 100000;
  }

  emitWave(patch, node, value, at) {
    const ctx = this.initialContext(patch, node);
    ctx.wave = value;
    this.onFire({ nodeId: node.id, time: at, kind: 'wave', value });
    this.send(patch, node.id, ctx, at, 0);
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
      // Left unset when the emitter follows the project, and read at the far
      // end instead. A latched Key node writes the project key, and a pulse can
      // now be bars in the air: the chord you hear has to be the one that is
      // current when the note sounds, not the one that was current when the
      // pulse left. A Key node or a line that sets a key writes real values
      // here, and those still win all the way down.
      scale: fromProject ? null : node.params.scale,
      root: fromProject ? null : node.params.root,
      velocity: node.params.velocity,
      transpose: 0,
      degreeShift: 0,
      origin: node.id,
    };
  }

  /** The key a pulse is in: what it carries, or the project's if it carries none. */
  keyOf(patch, ctx) {
    return {
      scale: ctx.scale ?? patch.scale,
      root: ctx.root ?? patch.root,
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

  /**
   * How long a pulse takes to walk a line, in beats.
   *
   * The line's length in grid cells times what a cell is worth. This is the
   * whole of the idea: the patch is laid out in time as well as in space, and
   * moving a node retimes the music. `line.delay` is added on top as a trim
   * for anything the grid cannot say.
   *
   * Routing a line is cheap but not free and this runs per pulse, so the
   * measurement is cached against the two nodes' positions -- drag either one
   * and the key changes, which is exactly when the answer changes too.
   */
  travelBeats(patch, line) {
    const from = nodeById(patch, line.from);
    const to = nodeById(patch, line.to);
    if (!from || !to) return 0;
    const key = `${from.col},${from.row},${to.col},${to.row},${patch.grid}`;
    const hit = this.travel.get(line.id);
    if (hit && hit.key === key) return hit.beats;
    const beats = lineCells(from, to) * gridBeats(patch.grid);
    this.travel.set(line.id, { key, beats });
    return beats;
  }

  /** Push a pulse down every outgoing line, applying each line's own state. */
  send(patch, nodeId, ctx, time, hops, stagger = 0) {
    if (hops > MAX_HOPS) return;
    const lines = outgoing(patch, nodeId);
    lines.forEach((line, i) => {
      if (line.muted) return;
      const delay = beatsToSeconds(this.travelBeats(patch, line) + line.delay + stagger * i, this.bpm);
      const arrive = time + delay;
      const next = this.applyLine(ctx, line);
      this.queue.push({ time: arrive, kind: 'arrive', nodeId: line.to, lineId: line.id, ctx: next, hops: hops + 1 });
      // Visual travel is decoupled: the dot lands exactly when the sound does.
      this.onPulse({
        lineId: line.id,
        fromTime: time,
        arriveTime: arrive,
        fromNode: nodeId,
        toNode: line.to,
        wave: ctx.wave !== undefined,
      });
    });
  }

  handleArrive(patch, evt) {
    const node = nodeById(patch, evt.nodeId);
    if (!node) return;
    if (evt.ctx.wave !== undefined) {
      this.handleWave(patch, node, evt);
      return;
    }
    const handler = this[`on_${node.type}`];
    if (handler) handler.call(this, patch, node, evt);
  }

  /**
   * A wave arriving somewhere. Only the nodes that can make sense of a value
   * without a moment attached act on it; the rest let it go by.
   */
  handleWave(patch, node, evt) {
    if (node.type === 'split') {
      this.send(patch, node.id, evt.ctx, evt.time, evt.hops, node.params.stagger);
      return;
    }
    if (node.type === 'key') {
      this.on_key(patch, node, evt);
      return;
    }
    if (node.type === 'param') {
      this.on_param(patch, node, evt);
      return;
    }
    // Everything else — notes, voices, gates, routers, chance — is about when
    // something happens, which a wave does not carry.
  }

  /** A pulse arriving at an LFO restarts its shape, so it can be locked to a bar. */
  on_lfo(patch, node, evt) {
    if (!node.params.reset) return;
    const state = this.state(`lfo:${node.id}`, { nextBeat: null, anchor: 0 });
    state.anchor = this.timeToBeat(evt.time);
    this.onFire({ nodeId: node.id, time: evt.time, kind: 'thru' });
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
    const arrive = evt.time + beatsToSeconds(this.travelBeats(patch, line) + line.delay, this.bpm);
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
      if (node.params.scope === 'midi') return s.lastValue ?? 0;
      const target = nodeById(patch, node.params.target);
      return target ? Number(target.params[key]) || 0 : 0;
    };

    let lo = Number(node.params.min);
    let hi = Number(node.params.max);
    if (node.params.scope === 'midi') {
      // A controller is seven bits, whatever the node was set to.
      lo = clamp(lo, 0, 127);
      hi = clamp(hi, 0, 127);
    }
    if (node.params.scope === 'node') {
      const spec = paramSpec(nodeById(patch, node.params.target)?.type, key);
      if (spec && Number.isFinite(spec.min)) lo = Math.max(lo, spec.min);
      if (spec && Number.isFinite(spec.max)) hi = Math.min(hi, spec.max);
    }
    if (!Number.isFinite(lo)) lo = 0;
    if (!Number.isFinite(hi)) hi = 127;
    if (hi < lo) [lo, hi] = [hi, lo];

    let value;
    if (ctx.wave !== undefined) {
      // The wave already carries a shaped value in its own range; the node's
      // mode is about generating one, which is not needed here.
      value = ctx.wave;
    } else if (node.params.mode === 'sequence') {
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

    if (node.params.scope === 'midi') {
      // The line decides where a CC goes, exactly as it decides where a note
      // goes, so a controller follows the instrument it belongs to.
      const value7 = clamp(Math.round(value), 0, 127);
      s.lastValue = value7;
      const sent = [];
      for (const chan of ctx.channels) {
        const went = this.midi.sendControl({
          slot: chan.out,
          channel: chan.ch,
          controller: node.params.cc,
          value: value7,
          at: evt.time,
        });
        if (went) sent.push(`${chan.out}:${chan.ch}`);
      }
      this.onFire({
        nodeId: node.id,
        time: evt.time,
        kind: 'cc',
        cc: clamp(Math.round(node.params.cc), 0, 127),
        value: value7,
        sent,
        fromWave: ctx.wave !== undefined,
      });
      this.send(patch, node.id, ctx, evt.time, evt.hops);
      return;
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
    const key = this.keyOf(patch, ctx);
    const base = resolveDegree(
      node.params.degree + (ctx.degreeShift || 0),
      key.scale,
      key.root,
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
    const key = this.keyOf(patch, ctx);
    const midiNote = clamp(
      Math.round(
        resolveDegree(
          node.params.degree + (ctx.degreeShift || 0),
          key.scale,
          key.root,
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
