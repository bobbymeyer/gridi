// Canvas renderer.
//
// Everything is drawn on the grid: nodes snap to it, lines turn right angles
// along it, and the grid itself is drawn rather than implied. Colours come from
// the stylesheet so the theme switch only has to happen in one place.

import { CELL, MODULE, nodeRect, portOut, routeLine, pointAlongPath, pathMidpoint } from './geometry.js';
import { typeMeta } from './nodes.js';
import { DIVISIONS, euclid, patternString } from './rhythm.js';
import { SCALES, NOTE_NAMES } from './music.js';
import { WAVE_LABELS } from './voice.js';
import { SHAPES, RATES } from './lfo.js';
import { outgoing, incoming, channelSummary } from './model.js';
import { clamp } from './util.js';
import { LIMITS } from './limits.js';

const FIRE_MS = 220;
const PULSE_MIN = 0.12; // seconds of visible travel for a zero-delay line
const PULSE_MAX = 1.4;

export function ordinal(n) {
  const v = Math.round(n);
  const abs = Math.abs(v);
  const tens = abs % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][abs % 10] ?? 'th';
  return `${v}${suffix}`;
}

export function keyName(root, scale) {
  return `${NOTE_NAMES[clamp(Math.round(root), 0, 11)]} ${(SCALES[scale] ?? SCALES.major).label}`;
}

/** The two lines of text a node shows on the canvas. */
export function nodeReadout(node, patch) {
  const p = node.params;
  switch (node.type) {
    case 'pulse': {
      const ratio = p.ratioNum !== 1 || p.ratioDen !== 1 ? ` ${p.ratioNum}:${p.ratioDen}` : '';
      const primary = `${DIVISIONS[p.division]?.label ?? p.division}${ratio}`;
      const feel = p.swing > 0 ? `SWING ${Math.round(p.swing * 100)}` : 'STRAIGHT';
      const secondary = p.euclidOn
        ? patternString(euclid(p.euclidPulses, p.euclidSteps, p.euclidRotate)).slice(0, 16)
        : `${feel} · CH ${p.channel}`;
      return { primary, secondary, muted: !p.running };
    }
    case 'lfo': {
      const rate = RATES[p.rate]?.label ?? p.rate;
      return {
        primary: (SHAPES[p.shape] ?? p.shape).toUpperCase(),
        secondary: `${rate} \u00b7 ${p.min}\u2013${p.max}`,
      };
    }
    case 'input': {
      const labels = { key: 'SETS KEY', transpose: 'TRANSPOSE', none: 'GATE' };
      return {
        primary: p.listen === 0 ? 'OMNI' : `CH ${p.listen}`,
        secondary: labels[p.sets] ?? 'GATE',
      };
    }
    case 'split': {
      const n = outgoing(patch, node.id).length;
      return { primary: 'ALL', secondary: `${n} BRANCH${n === 1 ? '' : 'ES'}` };
    }
    case 'gate': {
      const labels = { all: 'AND', any: 'OR', count: `${p.count} OF`, xor: 'XOR' };
      return { primary: labels[p.mode] ?? 'AND', secondary: `${incoming(patch, node.id).length} IN · ${p.windowMs}MS` };
    }
    case 'chance':
      return { primary: `${Math.round(p.probability)}%`, secondary: p.mode === 'drunk' ? 'DRIFT' : 'FREE' };
    case 'router': {
      const labels = { cycle: 'CYCLE', pingpong: 'PING-PONG', random: 'RANDOM', shuffle: 'NO REPEAT' };
      return { primary: labels[p.mode] ?? 'CYCLE', secondary: `${outgoing(patch, node.id).length} OUT` };
    }
    case 'note':
      return {
        primary: ordinal(p.degree).toUpperCase(),
        secondary: `OCT ${p.octave} · ${p.midiOn ? 'MIDI' : 'MUTE'}${p.ratchet > 1 ? ` · R${p.ratchet}` : ''}`,
      };
    case 'synth': {
      const oscs = [
        p.aLevel > 0 ? WAVE_LABELS[p.aWave] ?? 'SAW' : null,
        p.bLevel > 0 ? WAVE_LABELS[p.bWave] ?? 'SAW' : null,
      ].filter(Boolean);
      return {
        primary: ordinal(p.degree).toUpperCase(),
        secondary: `${oscs.join('+') || 'SILENT'} · ${Math.round(p.cutoff)}HZ`,
        muted: oscs.length === 0,
      };
    }
    case 'param': {
      if (p.scope === 'midi') {
        return { primary: `CC ${clamp(Math.round(p.cc), 0, 127)}`, secondary: `MIDI · ${p.mode.toUpperCase()}` };
      }
      const target = patch.nodes.find((n) => n.id === p.target);
      const where = p.scope === 'signal' ? 'SIGNAL' : (target ? typeMeta(target.type).label.toUpperCase() : 'NO TARGET');
      return { primary: (p.param || '—').toUpperCase(), secondary: `${where} · ${p.mode.toUpperCase()}` };
    }
    case 'key':
      return {
        primary: p.mode === 'set' ? keyName(p.root, p.scale).toUpperCase() : p.mode.toUpperCase(),
        secondary: p.latch ? 'LATCH · PROJECT' : 'DOWNSTREAM ONLY',
      };
    default:
      return { primary: node.type.toUpperCase(), secondary: '' };
  }
}

export class Renderer {
  constructor(canvas, ctxProviders) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.get = ctxProviders; // { patch, view, selection, ui, clock }
    this.pulses = [];
    this.fires = new Map();
    this.colors = {};
    this.dpr = 1;
    this.readColors();
    this.resize();
  }

  readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim();
    this.colors = {
      ink: v('--ink', '#111'),
      inkSoft: v('--ink-soft', '#6b6862'),
      paper: v('--paper', '#f2f0ea'),
      paper2: v('--paper-2', '#e7e4dc'),
      canvas: v('--canvas', '#f6f4ef'),
      red: v('--red', '#e1251b'),
      blue: v('--blue', '#1b3fd8'),
      yellow: v('--yellow', '#ffc500'),
      fine: v('--grid-fine', 'rgba(17,17,17,.09)'),
      module: v('--grid-module', 'rgba(17,17,17,.2)'),
    };
  }

  typeColor(type) {
    const name = typeMeta(type).color;
    return this.colors[name] ?? this.colors.ink;
  }

  /** Yellow needs dark text on it; the others take paper. */
  onColor(type) {
    return typeMeta(type).color === 'yellow' ? '#111111' : this.colors.paper;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
    this.width = rect.width;
    this.height = rect.height;
  }

  /* -------------------------------------------------------------- events */

  /**
   * A pulse is drawn arriving exactly when it sounds: the dot is launched
   * backwards from its arrival time rather than forwards from its departure.
   * A line with a musical delay shows the pulse crawling for that whole delay.
   */
  addPulse(evt) {
    const delaySec = evt.arriveTime - (evt.fromTime ?? evt.arriveTime);
    const travel = clamp(delaySec || PULSE_MIN, PULSE_MIN, PULSE_MAX);
    this.pulses.push({
      lineId: evt.lineId,
      start: evt.arriveTime - travel,
      end: evt.arriveTime,
      wave: Boolean(evt.wave),
    });
    const over = this.pulses.length - LIMITS.visualPulses;
    if (over > 0) this.pulses.splice(0, over);
  }

  addFire(evt) {
    this.fires.set(evt.nodeId, { time: evt.time, kind: evt.kind });
  }

  clearMotion() {
    this.pulses.length = 0;
    this.fires.clear();
  }

  /* ---------------------------------------------------------------- text */

  text(str, x, y, { size = 11, weight = 600, color = this.colors.ink, track = 0, align = 'left', baseline = 'alphabetic' } = {}) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px "Helvetica Neue", Helvetica, Inter, Arial, sans-serif`;
    ctx.fillStyle = color;
    ctx.textBaseline = baseline;
    if (track && 'letterSpacing' in ctx) {
      ctx.letterSpacing = `${track}px`;
      ctx.textAlign = align;
      ctx.fillText(str, x, y);
      ctx.letterSpacing = '0px';
      return;
    }
    if (!track) {
      ctx.textAlign = align;
      ctx.fillText(str, x, y);
      return;
    }
    // Manual tracking for engines without ctx.letterSpacing.
    ctx.textAlign = 'left';
    const chars = [...str];
    const width = chars.reduce((w, c) => w + ctx.measureText(c).width + track, -track);
    let cx = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    for (const c of chars) {
      ctx.fillText(c, cx, y);
      cx += ctx.measureText(c).width + track;
    }
  }

  /* ---------------------------------------------------------------- draw */

  frame() {
    const { patch, view, selection, ui, clock } = this.get();
    const ctx = this.ctx;
    const now = clock.now();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.colors.canvas;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.save();
    ctx.scale(view.zoom, view.zoom);
    ctx.translate(view.x, view.y);

    this.drawGrid(view);

    const index = new Map(patch.nodes.map((n) => [n.id, n]));
    for (const line of patch.lines) this.drawLine(patch, line, index, selection, view);
    for (const line of patch.lines) this.drawLinePulses(line, index, now, view);
    if (ui.pendingFrom) this.drawPending(index, ui, view);
    for (const node of patch.nodes) this.drawNode(patch, node, selection, now, view);
    if (ui.ghost) this.drawGhost(ui.ghost, view);

    ctx.restore();
    this.sweep(now);
  }

  drawGrid(view) {
    const ctx = this.ctx;
    const left = -view.x;
    const top = -view.y;
    const right = left + this.width / view.zoom;
    const bottom = top + this.height / view.zoom;
    const px = CELL * view.zoom;

    const startCol = Math.floor(left / CELL);
    const endCol = Math.ceil(right / CELL);
    const startRow = Math.floor(top / CELL);
    const endRow = Math.ceil(bottom / CELL);

    if (px >= 7) {
      ctx.strokeStyle = this.colors.fine;
      ctx.lineWidth = 1 / view.zoom;
      ctx.beginPath();
      for (let c = startCol; c <= endCol; c += 1) {
        if (c % MODULE === 0) continue;
        const x = c * CELL;
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
      }
      for (let r = startRow; r <= endRow; r += 1) {
        if (r % MODULE === 0) continue;
        const y = r * CELL;
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
      }
      ctx.stroke();
    }

    // The module rules are the emphasised structure of the composition.
    ctx.strokeStyle = this.colors.module;
    ctx.lineWidth = 1 / view.zoom;
    ctx.beginPath();
    for (let c = Math.floor(startCol / MODULE) * MODULE; c <= endCol; c += MODULE) {
      const x = c * CELL;
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (let r = Math.floor(startRow / MODULE) * MODULE; r <= endRow; r += MODULE) {
      const y = r * CELL;
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();

    // Origin marker: the one red accent in the field.
    ctx.strokeStyle = this.colors.red;
    ctx.lineWidth = 2 / view.zoom;
    ctx.beginPath();
    ctx.moveTo(-CELL, 0);
    ctx.lineTo(CELL, 0);
    ctx.moveTo(0, -CELL);
    ctx.lineTo(0, CELL);
    ctx.stroke();
  }

  linePath(line, index) {
    const from = index.get(line.from);
    const to = index.get(line.to);
    if (!from || !to) return null;
    return routeLine(from, to);
  }

  drawLine(patch, line, index, selection, view) {
    const ctx = this.ctx;
    const points = this.linePath(line, index);
    if (!points) return;
    const selected = selection.kind === 'line' && selection.id === line.id;
    const source = index.get(line.from);

    ctx.save();
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';
    ctx.setLineDash(line.muted ? [5 / view.zoom, 4 / view.zoom] : []);
    ctx.strokeStyle = selected ? this.colors.red : line.muted ? this.colors.inkSoft : this.colors.ink;
    ctx.lineWidth = (selected ? 3.5 : 2) / Math.max(view.zoom, 0.6);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrow head into the input port.
    const end = points[points.length - 1];
    const prev = points[points.length - 2] ?? end;
    const dx = Math.sign(end.x - prev.x);
    const dy = Math.sign(end.y - prev.y);
    ctx.fillStyle = selected ? this.colors.red : this.colors.ink;
    ctx.beginPath();
    const s = 5;
    if (dx !== 0) {
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - dx * s * 1.6, end.y - s);
      ctx.lineTo(end.x - dx * s * 1.6, end.y + s);
    } else {
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - s, end.y - dy * s * 1.6);
      ctx.lineTo(end.x + s, end.y - dy * s * 1.6);
    }
    ctx.closePath();
    ctx.fill();

    // Badges: what this line is carrying. Hidden when zoomed far out.
    if (view.zoom > 0.55) {
      const mid = pathMidpoint(points);
      const badges = [];
      if (line.channelMode === 'set') badges.push({ text: channelSummary(line), color: this.colors.blue });
      if (line.scaleMode === 'set') badges.push({ text: keyName(line.root, line.scale).toUpperCase(), color: this.colors.red });
      if (line.delay > 0) badges.push({ text: `+${line.delay}`, color: this.colors.ink });
      if (line.muted) badges.push({ text: 'MUTE', color: this.colors.inkSoft });

      let bx = mid.x;
      let by = mid.y - 9;
      for (const badge of badges) {
        ctx.font = '700 9px "Helvetica Neue", Helvetica, Arial, sans-serif';
        const w = ctx.measureText(badge.text).width + 10;
        ctx.fillStyle = badge.color;
        ctx.fillRect(bx - w / 2, by - 8, w, 14);
        this.text(badge.text, bx, by - 1, {
          size: 9,
          weight: 700,
          color: badge.color === this.colors.yellow ? '#111' : this.colors.paper,
          align: 'center',
          track: 0.6,
        });
        by += 17;
      }
      if (!badges.length && source) {
        // A quiet tick so an inheriting line still reads as a carrier.
        ctx.fillStyle = this.colors.inkSoft;
        ctx.fillRect(mid.x - 1.5, mid.y - 4, 3, 8);
      }
    }
    ctx.restore();
  }

  drawLinePulses(line, index, now, view) {
    const points = this.linePath(line, index);
    if (!points) return;
    const ctx = this.ctx;
    for (const pulse of this.pulses) {
      if (pulse.lineId !== line.id) continue;
      const span = pulse.end - pulse.start;
      const t = span > 0 ? (now - pulse.start) / span : 1;
      if (t < 0 || t > 1.02) continue;
      const p = pointAlongPath(points, clamp(t, 0, 1));
      // A wave is a stream of small marks rather than one bold one: what runs
      // down the line is a value, not an event.
      const size = (pulse.wave ? 5 : 9) / Math.max(view.zoom, 0.6);
      ctx.fillStyle = pulse.wave ? this.colors.blue : this.colors.red;
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
    }
  }

  drawPending(index, ui, view) {
    const from = index.get(ui.pendingFrom);
    if (!from) return;
    const ctx = this.ctx;
    const a = portOut(from);
    const b = ui.pendingTo;
    const midX = Math.round((a.x + b.x) / 2 / CELL) * CELL;
    ctx.save();
    ctx.strokeStyle = this.colors.blue;
    ctx.lineWidth = 2 / Math.max(view.zoom, 0.6);
    ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(midX, a.y);
    ctx.lineTo(midX, b.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  drawGhost(ghost, view) {
    const ctx = this.ctx;
    const r = nodeRect({ col: ghost.col, row: ghost.row });
    ctx.save();
    ctx.strokeStyle = this.typeColor(ghost.type);
    ctx.setLineDash([5 / view.zoom, 4 / view.zoom]);
    ctx.lineWidth = 2 / Math.max(view.zoom, 0.6);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  drawNode(patch, node, selection, now, view) {
    const ctx = this.ctx;
    const r = nodeRect(node);
    const meta = typeMeta(node.type);
    const color = this.typeColor(node.type);
    const selected = selection.kind === 'node' && selection.id === node.id;
    const fire = this.fires.get(node.id);
    const flash = fire && now >= fire.time ? clamp(1 - (now - fire.time) / (FIRE_MS / 1000), 0, 1) : 0;
    const blocked = fire && fire.kind === 'block';

    // Body.
    ctx.fillStyle = this.colors.paper;
    ctx.fillRect(r.x, r.y, r.w, r.h);

    if (flash > 0) {
      ctx.globalAlpha = flash * (blocked ? 0.18 : 0.85);
      ctx.fillStyle = blocked ? this.colors.inkSoft : color;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1;
    }

    // Header band.
    const band = 15;
    ctx.fillStyle = color;
    ctx.fillRect(r.x, r.y, r.w, band);

    const readout = nodeReadout(node, patch);
    const onBand = this.onColor(node.type);
    this.text((node.label || meta.label).toUpperCase(), r.x + 6, r.y + band - 4.5, {
      size: 9,
      weight: 700,
      color: onBand,
      track: 1,
    });
    const idx = patch.nodes.indexOf(node) + 1;
    this.text(String(idx).padStart(2, '0'), r.x + r.w - 6, r.y + band - 4.5, {
      size: 9,
      weight: 700,
      color: onBand,
      align: 'right',
      track: 0.5,
    });

    const bodyInk = flash > 0.45 && !blocked ? this.onColor(node.type) : this.colors.ink;
    this.text(readout.primary, r.x + 6, r.y + band + 20, {
      size: 15,
      weight: 700,
      color: readout.muted ? this.colors.inkSoft : bodyInk,
    });
    this.text(readout.secondary, r.x + 6, r.y + r.h - 7, {
      size: 8.5,
      weight: 600,
      color: flash > 0.45 && !blocked ? this.onColor(node.type) : this.colors.inkSoft,
      track: 0.7,
    });

    // Border, drawn last so nothing bleeds over it.
    ctx.strokeStyle = selected ? this.colors.red : this.colors.ink;
    ctx.lineWidth = (selected ? 3 : 2) / Math.max(view.zoom, 0.6);
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // Ports.
    if (meta.inputs !== 0) {
      ctx.fillStyle = this.colors.ink;
      ctx.fillRect(r.x - 4, r.y + r.h / 2 - 4, 4, 8);
    }
    if (meta.outputs !== 0) {
      // Drawn as an edge handle, matching the whole-edge grab zone.
      const hot = selection.hoverPort === node.id;
      const bar = r.h * 0.54;
      ctx.fillStyle = hot ? this.colors.blue : this.colors.ink;
      ctx.fillRect(r.x + r.w - 3, r.y + (r.h - bar) / 2, hot ? 12 : 7, bar);
    }
  }

  sweep(now) {
    if (this.pulses.length) {
      this.pulses = this.pulses.filter((p) => now <= p.end + 0.12);
    }
    for (const [id, fire] of this.fires) {
      if (now > fire.time + FIRE_MS / 1000) this.fires.delete(id);
    }
  }
}
