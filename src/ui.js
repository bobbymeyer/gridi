// Palette and inspector.
//
// The inspector is generated from the parameter schema in nodes.js rather than
// hand-written per node type, so adding a node type means adding data, not DOM.
// Rows keep live references and update in place: rebuilding on every keystroke
// would steal focus mid-edit.

import { NODE_TYPES, NODE_TYPE_KEYS, MODULATABLE, typeMeta } from './nodes.js';
import { SCALES, NOTE_NAMES } from './music.js';
import { channelSummary, createChannel, nodeById } from './model.js';
import { SLOTS, asSlot } from './midi.js';
import { clamp } from './util.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const GLYPHS = {
  circle: '<circle cx="8" cy="8" r="5.5"/>',
  fork: '<path d="M1 8h5M6 8V3h7M6 8v5h7" fill="none" stroke-width="2"/>',
  gate: '<path d="M3 2h3a6 6 0 010 12H3z"/>',
  half: '<path d="M2 2h12v12z"/>',
  router: '<path d="M1 8h5l7-4M6 8l7 4" fill="none" stroke-width="2"/>',
  diamond: '<path d="M8 1l7 7-7 7-7-7z"/>',
  wave: '<path d="M1 8c2.5-7 5 7 7.5 0s4 4 6.5 0" fill="none" stroke-width="2"/>',
  bars: '<rect x="2" y="10" width="3" height="4"/><rect x="6.5" y="5" width="3" height="9"/><rect x="11" y="2" width="3" height="12"/>',
  key: '<rect x="2" y="2" width="7" height="7"/><rect x="7" y="7" width="7" height="7"/>',
  keys: '<rect x="1" y="3" width="3" height="10"/><rect x="6" y="3" width="3" height="10"/><rect x="11" y="3" width="3" height="10"/>',
  curve: '<path d="M1 12c3.5 0 3.5-8 7-8s3.5 8 7 8" fill="none" stroke-width="2"/>',
};

function glyphSvg(type, color) {
  const meta = typeMeta(type);
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="${color}" stroke="${color}" aria-hidden="true">${
    GLYPHS[meta.glyph] ?? GLYPHS.diamond
  }</svg>`;
}

/* ---------------------------------------------------------------- palette */

export function buildPalette(container, { onPick, getActive }) {
  container.innerHTML = '';
  const buttons = [];
  NODE_TYPE_KEYS.forEach((type) => {
    const meta = NODE_TYPES[type];
    const btn = el('button', 'chip');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    btn.title = meta.blurb;

    const swatch = el('div', 'chip__swatch');
    swatch.style.background = `var(--${meta.color})`;
    swatch.innerHTML = glyphSvg(type, meta.color === 'yellow' ? '#111' : '#fff');

    const body = el('div', 'chip__body');
    body.append(el('span', 'chip__name', meta.label), el('span', 'chip__role', meta.role));
    btn.append(swatch, body);
    btn.addEventListener('click', () => onPick(type));
    buttons.push({ type, btn });
    container.append(btn);
  });

  return function sync() {
    const active = getActive();
    for (const { type, btn } of buttons) btn.setAttribute('aria-pressed', String(type === active));
  };
}

/* -------------------------------------------------------------- controls */

function formatValue(spec, value) {
  if (spec.format === 'percent') return `${Math.round(value * 100)}%`;
  if (spec.format === 'ordinal') return String(value);
  const n = Number(value);
  const text = Number.isInteger(n) ? String(n) : n.toFixed(spec.step && spec.step < 0.01 ? 3 : 2);
  return spec.unit ? `${text}${spec.unit === '%' ? '' : ' '}${spec.unit}` : text;
}

function makeRow(labelText) {
  const row = el('div', 'row');
  row.append(el('span', 'row__label', labelText));
  const control = el('div', 'row__control');
  row.append(control);
  return { row, control };
}

function optionsOf(spec) {
  return typeof spec.options === 'function' ? spec.options() : spec.options ?? [];
}

function buildSelect(values, current, onChange) {
  const sel = el('select', 'field');
  for (const opt of values) {
    const o = el('option', null, opt.label);
    o.value = String(opt.value);
    sel.append(o);
  }
  sel.value = String(current);
  sel.addEventListener('change', () => {
    const raw = sel.value;
    const match = values.find((v) => String(v.value) === raw);
    onChange(match ? match.value : raw);
  });
  return sel;
}

function buildStepper(spec, value, onChange) {
  const wrap = el('div', 'stepper');
  const dec = el('button', null, '−');
  const inc = el('button', null, '+');
  const input = el('input');
  dec.type = 'button';
  inc.type = 'button';
  input.type = 'number';
  input.value = String(value);
  if (Number.isFinite(spec.min)) input.min = String(spec.min);
  if (Number.isFinite(spec.max)) input.max = String(spec.max);
  input.step = String(spec.step ?? 1);

  const commit = (v) => {
    let n = Number(v);
    if (!Number.isFinite(n)) n = Number(value) || 0;
    if (Number.isFinite(spec.min)) n = Math.max(spec.min, n);
    if (Number.isFinite(spec.max)) n = Math.min(spec.max, n);
    input.value = String(n);
    onChange(n);
  };
  dec.addEventListener('click', () => commit(Number(input.value) - (spec.step ?? 1)));
  inc.addEventListener('click', () => commit(Number(input.value) + (spec.step ?? 1)));
  input.addEventListener('change', () => commit(input.value));
  wrap.append(dec, input, inc);
  wrap.sync = (v) => {
    if (document.activeElement !== input) input.value = String(v);
  };
  return wrap;
}

/* ------------------------------------------------------------- inspector */

export class Inspector {
  /**
   * @param {HTMLElement} root
   * @param {object} hooks { onParam, onNodeField, onLineField, onChannels, getReadout, onJump }
   */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.signature = '';
    this.rows = [];
  }

  show(patch, selection) {
    const signature =
      selection.kind === 'node'
        ? `node:${selection.id}:${nodeById(patch, selection.id)?.type ?? ''}`
        : selection.kind === 'line'
          ? `line:${selection.id}`
          : 'none';
    if (signature !== this.signature) {
      this.signature = signature;
      this.build(patch, selection);
    } else {
      this.refresh(patch, selection);
    }
  }

  build(patch, selection) {
    this.root.innerHTML = '';
    this.rows = [];
    if (selection.kind === 'node') this.buildNode(patch, nodeById(patch, selection.id));
    else if (selection.kind === 'line') this.buildLine(patch, patch.lines.find((l) => l.id === selection.id));
    else this.buildEmpty();
  }

  buildEmpty() {
    const box = el('div', 'pane__empty');
    box.append(el('p', 'micro', 'Select a node or a line. Pick a node type on the left, then click the grid to place it.'));
    this.root.append(box);
  }

  /* ------------------------------------------------------------ node view */

  buildNode(patch, node) {
    if (!node) return this.buildEmpty();
    const meta = typeMeta(node.type);

    const title = el('div', 'pane__title');
    const h = el('h2', null, meta.label);
    title.append(h, el('p', null, meta.blurb));
    this.root.append(title);

    const nameRow = makeRow('name');
    const nameInput = el('input', 'field');
    nameInput.type = 'text';
    nameInput.placeholder = meta.label;
    nameInput.value = node.label;
    nameInput.addEventListener('input', () => this.hooks.onNodeField(node, 'label', nameInput.value));
    nameRow.control.append(nameInput);
    this.root.append(nameRow.row);

    let currentGroup = null;
    for (const spec of meta.params) {
      const group = spec.group ?? 'settings';
      if (group !== currentGroup) {
        currentGroup = group;
        this.root.append(el('div', 'group', group));
      }
      this.addParamRow(patch, node, spec);
    }

    const stats = el('div', 'row row--readout');
    stats.append(el('span', 'row__label', 'patched'));
    const value = el('span', 'row__value');
    stats.append(value);
    this.root.append(stats);
    this.rows.push({
      spec: { key: '__patched', type: 'readout' },
      row: stats,
      sync: () => {
        const ins = patch.lines.filter((l) => l.to === node.id).length;
        const outs = patch.lines.filter((l) => l.from === node.id).length;
        value.textContent = `${ins} in / ${outs} out`;
      },
    });
    this.refresh(patch, { kind: 'node', id: node.id });
  }

  addParamRow(patch, node, spec) {
    const { row, control } = makeRow(spec.label);
    const value = node.params[spec.key];
    const set = (v) => {
      this.hooks.onParam(node, spec.key, v);
      this.refresh(patch, { kind: 'node', id: node.id });
    };
    let sync = () => {};

    if (spec.type === 'toggle') {
      const box = el('input');
      box.type = 'checkbox';
      box.checked = Boolean(value);
      box.addEventListener('change', () => set(box.checked));
      control.append(box);
      sync = () => {
        box.checked = Boolean(node.params[spec.key]);
      };
    } else if (spec.type === 'slider') {
      const range = el('input');
      range.type = 'range';
      range.min = String(spec.min);
      range.max = String(spec.max);
      range.step = String(spec.step);
      range.value = String(value);
      const out = el('span', 'row__value', formatValue(spec, value));
      range.addEventListener('input', () => {
        const v = Number(range.value);
        out.textContent = formatValue(spec, v);
        set(v);
      });
      control.append(range, out);
      sync = () => {
        const v = node.params[spec.key];
        if (document.activeElement !== range) range.value = String(v);
        out.textContent = formatValue(spec, v);
      };
    } else if (spec.type === 'number') {
      const stepper = buildStepper(spec, value, set);
      control.append(stepper);
      if (spec.hint && spec.hint.length < 6) control.append(el('span', 'row__label', spec.hint));
      sync = () => stepper.sync(node.params[spec.key]);
    } else if (spec.type === 'select') {
      const sel = buildSelect(optionsOf(spec), value, set);
      control.append(sel);
      sync = () => {
        sel.value = String(node.params[spec.key]);
      };
    } else if (spec.type === 'segmented') {
      const seg = el('div', 'seg');
      const opts = optionsOf(spec);
      const buttons = opts.map((opt) => {
        const b = el('button', null, opt.label);
        b.type = 'button';
        b.addEventListener('click', () => set(opt.value));
        seg.append(b);
        return { opt, b };
      });
      control.append(seg);
      sync = () => {
        for (const { opt, b } of buttons) {
          b.setAttribute('aria-pressed', String(String(node.params[spec.key]) === String(opt.value)));
        }
      };
    } else if (spec.type === 'text') {
      const input = el('input', 'field');
      input.type = 'text';
      input.value = String(value ?? '');
      input.addEventListener('input', () => this.hooks.onParam(node, spec.key, input.value));
      control.append(input);
      sync = () => {
        if (document.activeElement !== input) input.value = String(node.params[spec.key] ?? '');
      };
    } else if (spec.type === 'nodeRef') {
      const build = () => [
        { value: '', label: '— none —' },
        ...patch.nodes
          .filter((n) => n.id !== node.id && (MODULATABLE[n.type] ?? []).length > 0)
          .map((n) => ({
            value: n.id,
            label: `${String(patch.nodes.indexOf(n) + 1).padStart(2, '0')} ${n.label || typeMeta(n.type).label}`,
          })),
      ];
      const sel = buildSelect(build(), value ?? '', (v) => {
        this.hooks.onParam(node, 'target', v);
        const target = nodeById(patch, v);
        const allowed = target ? MODULATABLE[target.type] ?? [] : [];
        this.hooks.onParam(node, 'param', allowed[0] ?? '');
        this.build(patch, { kind: 'node', id: node.id });
      });
      control.append(sel);
      sync = () => {
        sel.value = String(node.params[spec.key] ?? '');
      };
    } else if (spec.type === 'paramRef') {
      const target = nodeById(patch, node.params.target);
      const allowed = target ? MODULATABLE[target.type] ?? [] : [];
      const sel = buildSelect(
        allowed.length ? allowed.map((k) => ({ value: k, label: k })) : [{ value: '', label: '— pick a target —' }],
        value ?? '',
        set,
      );
      control.append(sel);
      sync = () => {
        sel.value = String(node.params[spec.key] ?? '');
      };
    } else if (spec.type === 'readout') {
      row.classList.add('row--readout');
      const out = el('span', 'row__value', '—');
      control.append(out);
      sync = () => {
        out.textContent = this.hooks.getReadout(node, spec.key) ?? '—';
      };
    }

    this.root.append(row);
    if (spec.hint && spec.hint.length >= 6) {
      const hint = el('p', 'row__hint', spec.hint);
      row.append(hint);
    }
    this.rows.push({ spec, row, sync, node });
  }

  /* ------------------------------------------------------------ line view */

  buildLine(patch, line) {
    if (!line) return this.buildEmpty();
    const from = nodeById(patch, line.from);
    const to = nodeById(patch, line.to);

    const title = el('div', 'pane__title');
    title.append(el('h2', null, 'line'));
    title.append(
      el(
        'p',
        null,
        `${from?.label || typeMeta(from?.type ?? 'note').label} → ${to?.label || typeMeta(to?.type ?? 'note').label} · carries channels and key downstream`,
      ),
    );
    this.root.append(title);

    /* Channels ------------------------------------------------------------ */
    this.root.append(el('div', 'group', 'MIDI channels'));

    const modeRow = makeRow('mode');
    const seg = el('div', 'seg');
    const modes = [
      { value: 'inherit', label: 'inherit' },
      { value: 'set', label: 'set here' },
    ];
    const modeButtons = modes.map((m) => {
      const b = el('button', null, m.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.hooks.onLineField(line, 'channelMode', m.value);
        this.build(patch, { kind: 'line', id: line.id });
      });
      seg.append(b);
      return { m, b };
    });
    modeRow.control.append(seg);
    this.root.append(modeRow.row);
    this.rows.push({
      spec: { key: 'channelMode' },
      row: modeRow.row,
      sync: () => {
        for (const { m, b } of modeButtons) b.setAttribute('aria-pressed', String(line.channelMode === m.value));
      },
    });

    if (line.channelMode === 'set') {
      // The grid edits one output at a time, so the same channel number can be
      // carried to two devices at once — which is the point of having several.
      const slot = asSlot(this.channelSlot ?? line.channels[0]?.out);
      this.channelSlot = slot;

      const slotRow = makeRow('output');
      const slotSeg = el('div', 'seg');
      const slotButtons = SLOTS.map((name) => {
        const b = el('button', null, name);
        b.type = 'button';
        b.addEventListener('click', () => {
          this.channelSlot = name;
          this.build(patch, { kind: 'line', id: line.id });
        });
        slotSeg.append(b);
        return { name, b };
      });
      slotRow.control.append(slotSeg);
      this.root.append(slotRow.row);
      this.rows.push({
        spec: { key: 'channelSlot' },
        row: slotRow.row,
        sync: () => {
          for (const { name, b } of slotButtons) b.setAttribute('aria-pressed', String(name === slot));
        },
      });
      const slotHint = el('p', 'row__hint', 'Bind A\u2013D to devices in the header. The grid below sets channels on this one.');
      slotRow.row.append(slotHint);

      const grid = el('div', 'chan-grid');
      const chanButtons = [];
      const onSlot = (ch) => line.channels.some((c) => asSlot(c.out) === slot && c.ch === ch);
      for (let ch = 1; ch <= 16; ch += 1) {
        const b = el('button', null, String(ch));
        b.type = 'button';
        b.addEventListener('click', () => {
          const next = onSlot(ch)
            ? line.channels.filter((c) => !(asSlot(c.out) === slot && c.ch === ch))
            : [...line.channels, createChannel(ch, slot)];
          next.sort((a, c) => asSlot(a.out).localeCompare(asSlot(c.out)) || a.ch - c.ch);
          this.hooks.onChannels(line, next);
          this.build(patch, { kind: 'line', id: line.id });
        });
        chanButtons.push({ ch, b });
        grid.append(b);
      }
      this.root.append(grid);
      this.rows.push({
        spec: { key: 'channels' },
        row: grid,
        sync: () => {
          for (const { ch, b } of chanButtons) b.setAttribute('aria-pressed', String(onSlot(ch)));
        },
      });

      const list = el('div', 'chan-list');
      for (const chan of line.channels) {
        const item = el('div', 'chan-item');

        const where = el('select');
        for (const name of SLOTS) {
          const opt = el('option', null, name);
          opt.value = name;
          where.append(opt);
        }
        where.value = asSlot(chan.out);
        where.title = 'Which output this channel goes to';
        where.addEventListener('change', () => {
          chan.out = asSlot(where.value);
          this.hooks.onChannels(line, line.channels);
          this.build(patch, { kind: 'line', id: line.id });
        });
        item.append(where, el('b', null, String(chan.ch)));

        const tWrap = el('label');
        tWrap.append(el('span', null, 'transp'));
        const tInput = el('input');
        tInput.type = 'number';
        tInput.value = String(chan.transpose);
        tInput.step = '1';
        tInput.addEventListener('change', () => {
          chan.transpose = clamp(Math.round(Number(tInput.value) || 0), -48, 48);
          tInput.value = String(chan.transpose);
          this.hooks.onChannels(line, line.channels);
        });
        tWrap.append(tInput);

        const vWrap = el('label');
        vWrap.append(el('span', null, 'vel'));
        const vInput = el('input');
        vInput.type = 'number';
        vInput.placeholder = 'auto';
        vInput.value = chan.velocity == null ? '' : String(chan.velocity);
        vInput.addEventListener('change', () => {
          const raw = vInput.value.trim();
          chan.velocity = raw === '' ? null : clamp(Math.round(Number(raw) || 0), 1, 127);
          vInput.value = chan.velocity == null ? '' : String(chan.velocity);
          this.hooks.onChannels(line, line.channels);
        });
        vWrap.append(vInput);

        item.append(tWrap, vWrap);
        list.append(item);
      }
      if (!line.channels.length) list.append(el('p', 'row__hint', 'No channels: nothing downstream will sound.'));
      this.root.append(list);
    } else {
      const hint = el('p', 'row__hint', 'Passing through whatever the upstream pulse is carrying.');
      hint.style.padding = '8px 12px';
      this.root.append(hint);
    }

    /* Scale --------------------------------------------------------------- */
    this.root.append(el('div', 'group', 'scale and key'));

    const scaleModeRow = makeRow('mode');
    const scaleSeg = el('div', 'seg');
    const scaleModes = [
      { value: 'inherit', label: 'Inherit' },
      { value: 'set', label: 'Set here' },
    ];
    const scaleButtons = scaleModes.map((m) => {
      const b = el('button', null, m.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.hooks.onLineField(line, 'scaleMode', m.value);
        this.build(patch, { kind: 'line', id: line.id });
      });
      scaleSeg.append(b);
      return { m, b };
    });
    scaleModeRow.control.append(scaleSeg);
    this.root.append(scaleModeRow.row);
    this.rows.push({
      spec: { key: 'scaleMode' },
      row: scaleModeRow.row,
      sync: () => {
        for (const { m, b } of scaleButtons) b.setAttribute('aria-pressed', String(line.scaleMode === m.value));
      },
    });

    if (line.scaleMode === 'set') {
      const keyRow = makeRow('key');
      keyRow.control.append(
        buildSelect(NOTE_NAMES.map((n, i) => ({ value: i, label: n })), line.root, (v) =>
          this.hooks.onLineField(line, 'root', v)),
        buildSelect(
          Object.entries(SCALES).map(([value, s]) => ({ value, label: s.label })),
          line.scale,
          (v) => this.hooks.onLineField(line, 'scale', v),
        ),
      );
      this.root.append(keyRow.row);
    }

    /* Timing and state ---------------------------------------------------- */
    this.root.append(el('div', 'group', 'timing'));

    const delayRow = makeRow('delay');
    const delay = el('input');
    delay.type = 'range';
    delay.min = '0';
    delay.max = '4';
    delay.step = '0.0625';
    delay.value = String(line.delay);
    const delayOut = el('span', 'row__value', `${line.delay} b`);
    delay.addEventListener('input', () => {
      const v = Number(delay.value);
      delayOut.textContent = `${v} b`;
      this.hooks.onLineField(line, 'delay', v);
    });
    delayRow.control.append(delay, delayOut);
    this.root.append(delayRow.row);
    const delayHint = el('p', 'row__hint', 'In beats. Distance on the grid never affects timing.');
    delayRow.row.append(delayHint);

    const muteRow = makeRow('mute');
    const mute = el('input');
    mute.type = 'checkbox';
    mute.checked = line.muted;
    mute.addEventListener('change', () => this.hooks.onLineField(line, 'muted', mute.checked));
    muteRow.control.append(mute);
    this.root.append(muteRow.row);

    const summary = el('div', 'row row--readout');
    summary.append(el('span', 'row__label', 'carrying'));
    const summaryValue = el('span', 'row__value');
    summary.append(summaryValue);
    this.root.append(summary);
    this.rows.push({
      spec: { key: '__summary' },
      row: summary,
      sync: () => {
        summaryValue.textContent = channelSummary(line);
      },
    });

    this.refresh(patch, { kind: 'line', id: line.id });
  }

  /** Update values and re-evaluate every `when` condition, without rebuilding. */
  refresh(patch, selection) {
    const node = selection.kind === 'node' ? nodeById(patch, selection.id) : null;
    for (const entry of this.rows) {
      if (entry.spec.when && node) entry.row.hidden = !entry.spec.when(node.params);
      entry.sync();
    }
  }
}
