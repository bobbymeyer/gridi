// Application wiring: input, transport, persistence, and the frame loop.

import { AudioEngine } from './audio.js';
import { MidiOut, MIDI_SUPPORTED } from './midi.js';
import { Engine, TICK_MS } from './engine.js';
import { Renderer, keyName } from './render.js';
import { Inspector, buildPalette } from './ui.js';
import {
  createPatch, createNode, addNode, removeNode, removeLine, connect, canConnect,
  demoPatch, serialize, deserialize, nodeById,
} from './model.js';
import { typeMeta } from './nodes.js';
import { SCALES, NOTE_NAMES, noteName, resolveDegree } from './music.js';
import { euclid, patternString } from './rhythm.js';
import {
  CELL, screenToWorld, hitNode, hitOutPort, hitLine, snapCell, findFreeCell, nodeRect,
} from './geometry.js';
import { clamp } from './util.js';

const STORAGE_KEY = 'gridi.patch.v1';
const THEME_KEY = 'gridi.theme';
const MAX_HISTORY = 60;

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ state */

const state = {
  patch: createPatch(),
  selection: { kind: 'none', id: null, hoverPort: null },
  ui: { placing: null, ghost: null, pendingFrom: null, pendingTo: null },
  drag: null,
  lastNotes: new Map(), // nodeId -> text, for the "now plays" readout
  log: [],
};

const history = { past: [], future: [] };

const audio = new AudioEngine();
const midi = new MidiOut(audio);
const canvas = $('canvas');

const renderer = new Renderer(canvas, () => ({
  patch: state.patch,
  view: state.patch.view,
  selection: state.selection,
  ui: state.ui,
  clock: audio,
}));

const engine = new Engine({
  getPatch: () => state.patch,
  audio,
  midi,
  onPulse: (evt) => renderer.addPulse(evt),
  onFire: (evt) => {
    renderer.addFire(evt);
    if (evt.kind === 'note' && evt.notes?.length) {
      const text = evt.notes.map((n) => noteName(n.note)).join(' ');
      state.lastNotes.set(evt.nodeId, `${text}${evt.notes[0].ch ? ` · CH ${evt.notes.map((n) => n.ch).join(',')}` : ''}`);
      pushLog(`${text} → ${evt.notes.map((n) => (n.ch ? `CH${n.ch}` : 'VOICE')).join(' ')}`);
    } else if (evt.kind === 'key') {
      pushLog(`KEY → ${keyName(evt.root, evt.scale).toUpperCase()}`);
    }
  },
});

function pushLog(text) {
  state.log.unshift(text);
  if (state.log.length > 6) state.log.pop();
}

/* -------------------------------------------------------------- undo/save */

function snapshot() {
  history.past.push(serialize(state.patch));
  if (history.past.length > MAX_HISTORY) history.past.shift();
  history.future.length = 0;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, serialize(state.patch));
    } catch {
      /* private mode, or quota. Not fatal. */
    }
  }, 400);
}

/** Frame the whole patch, so a loaded file is never off screen. */
function fitView() {
  const patch = state.patch;
  const rect = canvas.getBoundingClientRect();
  if (!patch.nodes.length || rect.width < 10) {
    patch.view = { x: 40, y: 40, zoom: 1 };
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of patch.nodes) {
    const r = nodeRect(node);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  const pad = CELL * 3;
  const zoom = clamp(
    Math.min(rect.width / (maxX - minX + pad * 2), rect.height / (maxY - minY + pad * 2)),
    0.32,
    1,
  );
  patch.view = {
    zoom,
    x: -minX + (rect.width / zoom - (maxX - minX)) / 2,
    y: -minY + (rect.height / zoom - (maxY - minY)) / 2,
  };
}

function loadPatch(patch, { keepHistory = false } = {}) {
  if (!keepHistory) {
    history.past.length = 0;
    history.future.length = 0;
  }
  state.patch = patch;
  state.selection = { kind: 'none', id: null, hoverPort: null };
  state.lastNotes.clear();
  renderer.clearMotion();
  fitView();
  syncHeader();
  inspector.signature = '';
  save();
}

function undo() {
  if (!history.past.length) return;
  const view = { ...state.patch.view };
  history.future.push(serialize(state.patch));
  state.patch = deserialize(history.past.pop());
  state.patch.view = view;
  state.selection = { kind: 'none', id: null, hoverPort: null };
  inspector.signature = '';
  syncHeader();
  save();
  setStatus('Undo.');
}

function redo() {
  if (!history.future.length) return;
  const view = { ...state.patch.view };
  history.past.push(serialize(state.patch));
  state.patch = deserialize(history.future.pop());
  state.patch.view = view;
  state.selection = { kind: 'none', id: null, hoverPort: null };
  inspector.signature = '';
  syncHeader();
  save();
  setStatus('Redo.');
}

/* ------------------------------------------------------------------- chrome */

const counts = (patch) =>
  `${patch.nodes.length} node${patch.nodes.length === 1 ? '' : 's'} \u00b7 ${patch.lines.length} line${patch.lines.length === 1 ? '' : 's'}`;

function setStatus(text, strong = '') {
  $('status').innerHTML = strong ? `<b>${strong}</b> ${text}` : text;
}

const syncPalette = buildPalette($('palette'), {
  onPick: (type) => {
    state.ui.placing = state.ui.placing === type ? null : type;
    state.ui.ghost = null;
    syncPalette();
    const placing = $('placing');
    placing.hidden = !state.ui.placing;
    if (state.ui.placing) {
      placing.textContent = `Placing ${typeMeta(state.ui.placing).label} — click the grid`;
    }
  },
  getActive: () => state.ui.placing,
});

const inspector = new Inspector($('inspector'), {
  onParam: (node, key, value) => {
    node.params[key] = value;
    // Switching a Param node between node and signal scope invalidates whatever
    // it was pointed at, so give it a sensible starting point instead of a stale one.
    if (node.type === 'param' && key === 'scope') {
      node.params.param = value === 'signal' ? 'velocity' : '';
      if (value === 'signal') node.params.target = '';
    }
    save();
  },
  onNodeField: (node, key, value) => {
    node[key] = value;
    save();
  },
  onLineField: (line, key, value) => {
    line[key] = value;
    save();
  },
  onChannels: (line, channels) => {
    line.channels = channels;
    save();
  },
  getReadout: (node, key) => {
    if (key === 'pattern') {
      return patternString(euclid(node.params.euclidPulses, node.params.euclidSteps, node.params.euclidRotate));
    }
    if (key === 'resolved') {
      const heard = state.lastNotes.get(node.id);
      if (heard) return heard;
      const preview = resolveDegree(
        node.params.degree,
        state.patch.scale,
        state.patch.root,
        node.params.octave,
        node.params.degreeMode,
      );
      return `${noteName(preview)} (in ${keyName(state.patch.root, state.patch.scale)})`;
    }
    return '—';
  },
});

function syncHeader() {
  $('bpm').value = String(Math.round(state.patch.bpm));
  $('root').value = String(state.patch.root);
  $('scale').value = state.patch.scale;
  $('counts').textContent = counts(state.patch);
  $('sel-kind').textContent =
    state.selection.kind === 'node'
      ? (nodeById(state.patch, state.selection.id)?.label || typeMeta(nodeById(state.patch, state.selection.id)?.type ?? 'note').label)
      : state.selection.kind === 'line'
        ? 'Line'
        : 'Nothing';
}

function select(kind, id) {
  state.selection.kind = kind;
  state.selection.id = id;
  inspector.show(state.patch, state.selection);
  syncHeader();
}

/* ------------------------------------------------------------ transport UI */

let ticker = null;

async function play() {
  const ok = await audio.resume();
  if (!ok) setStatus('Audio context blocked. Click play again.', 'Note:');
  engine.start();
  ticker = setInterval(() => engine.tick(), TICK_MS);
  $('play').setAttribute('aria-pressed', 'true');
  $('play').textContent = 'Stop';
  $('run-dot').dataset.on = 'true';
  setStatus(midi.enabled ? 'Sending MIDI.' : 'Playing through the built-in voices.', 'Running.');
}

function stop() {
  clearInterval(ticker);
  ticker = null;
  engine.stop();
  renderer.clearMotion();
  $('play').setAttribute('aria-pressed', 'false');
  $('play').textContent = 'Play';
  $('run-dot').dataset.on = 'false';
  setStatus('Stopped.', '');
}

const toggleTransport = () => (engine.running ? stop() : play());

/* ------------------------------------------------------------- pointer i/o */

function pointerWorld(e) {
  const rect = canvas.getBoundingClientRect();
  return screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, state.patch.view);
}

const nodeIndex = () => new Map(state.patch.nodes.map((n) => [n.id, n]));

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const world = pointerWorld(e);

  if (e.button === 1 || e.altKey) {
    state.drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, view: { ...state.patch.view } };
    return;
  }

  if (state.ui.placing) {
    const type = state.ui.placing;
    const spot = findFreeCell(state.patch, snapCell(world.x) - 3, snapCell(world.y) - 1);
    snapshot();
    const node = addNode(state.patch, createNode(type, spot.col, spot.row));
    if (!e.shiftKey) {
      state.ui.placing = null;
      $('placing').hidden = true;
      syncPalette();
    }
    select('node', node.id);
    save();
    setStatus(`${typeMeta(type).label} placed.`, '');
    return;
  }

  const port = hitOutPort(state.patch, world);
  if (port) {
    state.ui.pendingFrom = port.id;
    state.ui.pendingTo = world;
    state.drag = { kind: 'connect' };
    return;
  }

  const node = hitNode(state.patch, world);
  if (node) {
    select('node', node.id);
    snapshot();
    state.drag = {
      kind: 'node',
      id: node.id,
      grabCol: snapCell(world.x) - node.col,
      grabRow: snapCell(world.y) - node.row,
      moved: false,
    };
    return;
  }

  const line = hitLine(state.patch, world, nodeIndex());
  if (line) {
    select('line', line.id);
    return;
  }

  select('none', null);
  state.drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, view: { ...state.patch.view } };
});

canvas.addEventListener('pointermove', (e) => {
  const world = pointerWorld(e);
  const drag = state.drag;

  if (drag?.kind === 'pan') {
    state.patch.view.x = drag.view.x + (e.clientX - drag.startX) / state.patch.view.zoom;
    state.patch.view.y = drag.view.y + (e.clientY - drag.startY) / state.patch.view.zoom;
    return;
  }

  if (drag?.kind === 'node') {
    const node = nodeById(state.patch, drag.id);
    if (node) {
      const col = snapCell(world.x) - drag.grabCol;
      const row = snapCell(world.y) - drag.grabRow;
      if (col !== node.col || row !== node.row) drag.moved = true;
      node.col = col;
      node.row = row;
    }
    return;
  }

  if (drag?.kind === 'connect') {
    state.ui.pendingTo = world;
    const over = hitNode(state.patch, world);
    canvas.style.cursor = over && canConnect(state.patch, state.ui.pendingFrom, over.id) ? 'copy' : 'not-allowed';
    return;
  }

  // Idle hover: highlight the output port, and preview placement.
  const port = hitOutPort(state.patch, world);
  state.selection.hoverPort = port ? port.id : null;
  if (state.ui.placing) {
    state.ui.ghost = { type: state.ui.placing, col: snapCell(world.x) - 3, row: snapCell(world.y) - 1 };
  } else {
    state.ui.ghost = null;
  }
  canvas.style.cursor = port ? 'crosshair' : hitNode(state.patch, world) ? 'grab' : 'default';
});

canvas.addEventListener('pointerup', (e) => {
  const drag = state.drag;
  state.drag = null;
  canvas.style.cursor = 'default';

  if (drag?.kind === 'connect') {
    const world = pointerWorld(e);
    const target = hitNode(state.patch, world);
    const fromId = state.ui.pendingFrom;
    state.ui.pendingFrom = null;
    state.ui.pendingTo = null;
    if (target && canConnect(state.patch, fromId, target.id)) {
      snapshot();
      const line = connect(state.patch, fromId, target.id);
      select('line', line.id);
      save();
      setStatus('The line carries channels and key downstream.', 'Connected.');
    } else if (target) {
      setStatus(
        target.id === fromId ? 'A node cannot feed itself.' : 'Those are already patched, or the target takes no input.',
        'No:',
      );
    }
    return;
  }

  if (drag?.kind === 'node' && !drag.moved) history.past.pop(); // nothing actually moved
  if (drag?.kind === 'node' && drag.moved) save();
});

canvas.addEventListener('dblclick', (e) => {
  const world = pointerWorld(e);
  const line = hitLine(state.patch, world, nodeIndex());
  if (line) {
    snapshot();
    line.muted = !line.muted;
    select('line', line.id);
    save();
    setStatus(line.muted ? 'Line muted.' : 'Line live.', '');
  }
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const view = state.patch.view;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = screenToWorld({ x: sx, y: sy }, view);
    const factor = Math.exp(-e.deltaY * 0.0014);
    view.zoom = clamp(view.zoom * factor, 0.32, 2.6);
    const after = screenToWorld({ x: sx, y: sy }, view);
    view.x += after.x - before.x;
    view.y += after.y - before.y;
  },
  { passive: false },
);

/* ---------------------------------------------------------------- keyboard */

const typing = () => {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
};

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;

  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    exportPatch();
    return;
  }
  if (typing()) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }

  if (e.code === 'Space') {
    e.preventDefault();
    toggleTransport();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelection();
    return;
  }
  if (e.key === 'Escape') {
    state.ui.placing = null;
    state.ui.pendingFrom = null;
    state.ui.ghost = null;
    $('placing').hidden = true;
    syncPalette();
    select('none', null);
    return;
  }
  if (e.key.toLowerCase() === 'd') duplicateSelection();
  if (e.key.toLowerCase() === 'f') {
    fitView();
    setStatus('View fitted to the patch.', '');
  }
  if (e.key.toLowerCase() === 'm' && state.selection.kind === 'line') {
    const line = state.patch.lines.find((l) => l.id === state.selection.id);
    if (line) {
      snapshot();
      line.muted = !line.muted;
      inspector.signature = '';
      select('line', line.id);
      save();
    }
  }
});

function deleteSelection() {
  const { kind, id } = state.selection;
  if (kind === 'node') {
    snapshot();
    removeNode(state.patch, id);
    select('none', null);
    save();
    setStatus('Node removed, along with its lines.', '');
  } else if (kind === 'line') {
    snapshot();
    removeLine(state.patch, id);
    select('none', null);
    save();
    setStatus('Line removed.', '');
  }
}

function duplicateSelection() {
  if (state.selection.kind !== 'node') return;
  const node = nodeById(state.patch, state.selection.id);
  if (!node) return;
  snapshot();
  const spot = findFreeCell(state.patch, node.col, node.row + 4);
  const copy = addNode(state.patch, createNode(node.type, spot.col, spot.row, { ...node.params }));
  copy.label = node.label;
  select('node', copy.id);
  save();
  setStatus('Duplicated.', '');
}

/* ------------------------------------------------------------ file, header */

function exportPatch() {
  const blob = new Blob([serialize(state.patch)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(state.patch.name || 'gridi-patch').replace(/[^\w-]+/g, '-').toLowerCase()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus('Patch saved to your downloads.', '');
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    loadPatch(deserialize(await file.text()));
    setStatus(`Opened ${file.name}.`, '');
  } catch {
    setStatus('That file could not be read as a patch.', 'Sorry:');
  }
  e.target.value = '';
});

$('play').addEventListener('click', toggleTransport);
$('import').addEventListener('click', () => $('file').click());
$('export').addEventListener('click', exportPatch);
$('new').addEventListener('click', () => {
  loadPatch(createPatch('Untitled'));
  setStatus('Empty grid. Pick a Pulse from the left to start.', 'New patch.');
});
$('demo').addEventListener('click', () => {
  loadPatch(demoPatch());
  setStatus('Demo patch loaded.', '');
});
$('duplicate').addEventListener('click', duplicateSelection);
$('delete').addEventListener('click', deleteSelection);
$('panic').addEventListener('click', () => {
  midi.allOff();
  audio.allOff();
  setStatus('All notes off.', 'Panic.');
});

$('bpm').addEventListener('change', () => {
  state.patch.bpm = clamp(Number($('bpm').value) || 120, 20, 300);
  $('bpm').value = String(state.patch.bpm);
  engine.setBpm(state.patch.bpm);
  save();
});

$('volume').addEventListener('input', () => audio.setVolume(Number($('volume').value)));

$('theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  $('theme').textContent = next === 'dark' ? 'Light' : 'Dark';
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore */
  }
  renderer.readColors();
});

/* --------------------------------------------------------------------- MIDI */

function syncMidi() {
  const select = $('midi-out');
  select.innerHTML = '';
  for (const out of midi.outputs) {
    const opt = document.createElement('option');
    opt.value = out.id;
    opt.textContent = out.manufacturer ? `${out.name} — ${out.manufacturer}` : out.name;
    select.append(opt);
  }
  select.disabled = midi.outputs.length === 0;
  if (midi.outputId) select.value = midi.outputId;

  const btn = $('midi-enable');
  if (midi.status === 'ready') {
    btn.textContent = 'MIDI On';
    btn.setAttribute('aria-pressed', 'true');
  } else if (midi.status === 'no-ports') {
    btn.textContent = 'No ports';
    btn.setAttribute('aria-pressed', 'false');
  } else {
    btn.textContent = 'Enable MIDI';
    btn.setAttribute('aria-pressed', 'false');
  }
}

midi.onChange = syncMidi;

$('midi-enable').addEventListener('click', async () => {
  const ok = await midi.enable();
  if (ok && midi.outputs.length) {
    setStatus(`Sending to ${midi.outputs[0].name}.`, 'MIDI ready.');
  } else if (ok) {
    setStatus('No MIDI outputs found. Open a virtual port (IAC on macOS, loopMIDI on Windows) and try again.', 'MIDI on.');
  } else if (midi.status === 'unsupported') {
    setStatus('This browser has no Web MIDI. Use Chrome, Edge, Opera or Firefox 108+. The built-in voices still work.', 'No MIDI.');
  } else if (midi.status === 'denied') {
    setStatus('MIDI permission was refused. Reload and allow it, or keep using the built-in voices.', 'Blocked.');
  } else {
    setStatus('MIDI could not be started.', 'Error.');
  }
});

$('midi-out').addEventListener('change', (e) => {
  midi.setOutput(e.target.value);
  const name = midi.outputs.find((o) => o.id === e.target.value)?.name;
  setStatus(`Sending to ${name}.`, 'MIDI.');
});

/* --------------------------------------------------------------- boot loop */

function populateKeySelects() {
  const root = $('root');
  NOTE_NAMES.forEach((name, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = name;
    root.append(opt);
  });
  const scale = $('scale');
  for (const [key, def] of Object.entries(SCALES)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = def.label;
    scale.append(opt);
  }
  root.addEventListener('change', () => {
    state.patch.root = Number(root.value);
    save();
  });
  scale.addEventListener('change', () => {
    state.patch.scale = scale.value;
    save();
  });
}

function showEnvironmentWarning() {
  if (MIDI_SUPPORTED && window.isSecureContext) return;
  const warn = document.createElement('div');
  warn.className = 'warn';
  warn.textContent = !window.isSecureContext
    ? 'Not a secure context — Web MIDI needs https or localhost. The built-in voices still work.'
    : 'This browser has no Web MIDI (Safari and every iOS browser). The built-in voices still work; use Chrome, Edge, Opera or Firefox 108+ to send MIDI out.';
  document.querySelector('.head').after(warn);
}

let lastChrome = 0;
function frame(now) {
  renderer.frame();

  if (now - lastChrome > 90) {
    lastChrome = now;
    const pos = engine.position();
    $('position').textContent = `${String(pos.bar).padStart(3, '0')}.${pos.beat}`;
    $('log').textContent = state.log.length ? state.log.join('   ·   ') : '—';
    $('counts').textContent = counts(state.patch);
    if (state.selection.kind !== 'none') inspector.show(state.patch, state.selection);
  }
  requestAnimationFrame(frame);
}

function boot() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark') {
      document.documentElement.dataset.theme = 'dark';
      $('theme').textContent = 'Light';
    }
  } catch {
    /* ignore */
  }
  renderer.readColors();

  populateKeySelects();
  showEnvironmentWarning();
  syncMidi();

  let initial = null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) initial = deserialize(stored);
  } catch {
    initial = null;
  }
  loadPatch(initial && initial.nodes.length ? initial : demoPatch());
  inspector.show(state.patch, state.selection);
  audio.setVolume(Number($('volume').value));

  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(canvas);
  window.addEventListener('resize', () => renderer.resize());
  renderer.resize();
  fitView();

  setStatus('Press play, or space.', 'Ready.');
  requestAnimationFrame(frame);
}

boot();

// The running singletons, so a browser check (or a console) can observe the
// live app rather than a rebuilt copy of it. Importing this module again
// returns the same instances; boot() does not run twice.
export { state, audio, midi, engine, renderer };
