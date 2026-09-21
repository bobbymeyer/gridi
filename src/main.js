// Application wiring: input, transport, persistence, and the frame loop.

import { AudioEngine } from './audio.js';
import { MidiOut, MIDI_SUPPORTED, SLOTS } from './midi.js';
import { MidiIn } from './midi-in.js';
import { Engine, TICK_MS } from './engine.js';
import { Renderer, keyName } from './render.js';
import { Inspector, buildPalette } from './ui.js';
import {
  createPatch, createNode, addNode, removeNode, removeLine, connect, canConnect,
  demoPatch, serialize, deserialize, readPatch, nodeById, usedChannels, soundFor, setSound,
} from './model.js';
import { programName, programsFor, DRUM_CHANNEL } from './gm.js';
import { SoundFont } from './soundfont.js';
import { keepSoundfont, recallSoundfont, forgetSoundfont } from './store.js';
import { typeMeta } from './nodes.js';
import { SCALES, NOTE_NAMES, noteName, resolveDegree } from './music.js';
import { euclid, patternString, GRID_KEYS } from './rhythm.js';
import {
  CELL, screenToWorld, hitNode, hitOutPort, hitLine, snapCell, findFreeCell, nodeRect,
} from './geometry.js';
import { clamp } from './util.js';
import { Governor, LIMITS, SCOPE_NOTE } from './limits.js';

const STORAGE_KEY = 'gridi.patch.v1';
const THEME_KEY = 'gridi.theme';
// Device bindings live on the machine, not in the patch: a patch names output
// slots, and each machine decides what sits behind them.
const OUTPUTS_KEY = 'gridi.outputs.v1';
const MAX_HISTORY = 60;

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ state */

const state = {
  patch: createPatch(),
  selection: { kind: 'none', id: null, hoverPort: null },
  ui: { placing: null, ghost: null, pendingFrom: null, pendingTo: null },
  drag: null,
  lastNotes: new Map(), // nodeId -> text, for the "now plays" readout
  lastCC: new Map(), // nodeId -> text, for the CC readout
  lastPlayed: null, // the most recent note in from a keyboard
  lastWave: new Map(), // nodeId -> the value an LFO is putting out
  log: [],
};

const history = { past: [], future: [] };

const audio = new AudioEngine();
const midi = new MidiOut(audio);
const midiIn = new MidiIn(midi);
const canvas = $('canvas');

/**
 * Limit breaches surface here. The banner always carries the same closing
 * point, because it is nearly always the real answer: this is a MIDI
 * sequencer, and the synth in it is a sketchpad.
 */
const governor = new Governor((trip) => showGuard(trip));
audio.governor = governor;
midi.governor = governor;
midiIn.governor = governor;

function showGuard({ title, detail, note, repeats }) {
  const count = repeats > 1 ? ` (${repeats}\u00d7)` : '';
  $('guard-title').textContent = note ? `${title} — ${note}${count}` : `${title}${count}`;
  $('guard-detail').textContent = detail;
  $('guard-scope').textContent = SCOPE_NOTE;
  $('guard').hidden = false;
}

function hideGuard() {
  $('guard').hidden = true;
}

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
  governor,
  onExternalTransport: (what) => {
    if (what === 'stop') {
      if (engine.running) stop();
      setStatus('The master stopped.', 'Synced.');
    } else if (!engine.running) {
      play();
      setStatus(what === 'continue' ? 'Following the master from where it was.' : 'Following the master.', 'Synced.');
    }
  },
  onOverload: ({ stop: shouldStop }) => {
    if (shouldStop && engine.running) {
      stop();
      setStatus('Transport stopped: the patch kept overloading. Look for a line that loops back on itself.', 'Halted.');
    }
  },
  onPulse: (evt) => renderer.addPulse(evt),
  onFire: (evt) => {
    renderer.addFire(evt);
    if (evt.kind === 'note' && evt.notes?.length) {
      const text = evt.notes.map((n) => noteName(n.note)).join(' ');
      state.lastNotes.set(evt.nodeId, `${text}${evt.notes[0].ch ? ` · ch ${evt.notes.map((n) => n.ch).join(',')}` : ''}`);
      pushLog(`${text} → ${evt.notes.map((n) => (n.ch ? `ch${n.ch}` : 'voice')).join(' ')}`);
    } else if (evt.kind === 'key') {
      pushLog(`key → ${keyName(evt.root, evt.scale)}`);
    } else if (evt.kind === 'cc') {
      const where = evt.sent.length ? evt.sent.join(' ') : 'nowhere';
      state.lastCC.set(evt.nodeId, `${evt.value} → ${where}`);
      // An LFO sends dozens a second; logging each would bury everything else.
      if (evt.sent.length && !evt.fromWave) pushLog(`CC${evt.cc} ${evt.value} → ${where}`);
    } else if (evt.kind === 'wave') {
      state.lastWave.set(evt.nodeId, evt.value);
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
  governor.reset();
  hideGuard();
  if (!keepHistory) {
    history.past.length = 0;
    history.future.length = 0;
  }
  state.patch = patch;
  state.selection = { kind: 'none', id: null, hoverPort: null };
  state.lastNotes.clear();
  state.lastCC.clear();
  state.lastWave.clear();
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

/** A patch larger than Gridi will hold is truncated rather than allowed in. */
function onPatchLimit(kind, asked, kept) {
  governor.trip('patch', audio.now(), `${asked} ${kind}, kept ${kept}`);
}

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
      placing.textContent = `placing ${typeMeta(state.ui.placing).label} — click the grid`;
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
      if (value !== 'node') node.params.target = '';
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
    if (key === 'value') {
      const now = state.lastWave.get(node.id);
      return now === undefined ? 'stopped' : now.toFixed(1);
    }
    if (key === 'wired') {
      const fed = state.patch.lines
        .filter((l) => l.from === node.id)
        .map((l) => nodeById(state.patch, l.to))
        .filter(Boolean);
      if (!fed.length) return 'nothing yet';
      const useful = fed.filter((n) => n.type === 'param' || n.type === 'split' || n.type === 'key');
      if (!useful.length) return `${typeMeta(fed[0].type).label} — ignores waves`;
      return useful.map((n) => n.label || typeMeta(n.type).label).join(', ');
    }
    if (key === 'played') {
      const played = state.lastPlayed;
      return played ? `${noteName(played.note)} vel ${played.velocity} ch ${played.channel}` : 'nothing yet';
    }
    if (key === 'ccTarget') {
      const heard = state.lastCC.get(node.id);
      if (heard) return heard;
      return 'whatever channels the line carries';
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
  $('clock-out').setAttribute('aria-pressed', String(state.patch.clockOut !== false));
  $('bpm').disabled = state.patch.sync === 'external';
  syncMidiIn();
  $('root').value = String(state.patch.root);
  $('scale').value = state.patch.scale;
  $('grid').value = state.patch.grid;
  // Set unconditionally, caret included: opening a patch has to rename the
  // field even when the cursor is sitting in it, or the canvas and the label
  // disagree about what is loaded. Writing the same string back is a no-op, so
  // typing is not disturbed.
  const named = state.patch.name === 'Untitled' ? '' : state.patch.name;
  if ($('patch-name').value !== named) $('patch-name').value = named;
  $('counts').textContent = counts(state.patch);
  $('sel-kind').textContent =
    state.selection.kind === 'node'
      ? (nodeById(state.patch, state.selection.id)?.label || typeMeta(nodeById(state.patch, state.selection.id)?.type ?? 'note').label)
      : state.selection.kind === 'line'
        ? 'line'
        : 'nothing';
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
  $('play').textContent = 'stop';
  $('run-dot').dataset.on = 'true';
  const clock = state.patch.clockOut !== false ? ' with clock' : '';
  setStatus(midi.enabled ? `Sending MIDI${clock}.` : 'Playing through the built-in voices.', 'Running.');
}

function stop() {
  clearInterval(ticker);
  ticker = null;
  engine.stop();
  renderer.clearMotion();
  $('play').setAttribute('aria-pressed', 'false');
  $('play').textContent = 'play';
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
    if (state.patch.nodes.length >= LIMITS.nodes) {
      governor.trip('patch', audio.now(), `${LIMITS.nodes} nodes is the limit`);
      return;
    }
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
    if (target && state.patch.lines.length >= LIMITS.lines) {
      governor.trip('patch', audio.now(), `${LIMITS.lines} lines is the limit`);
      setStatus('This patch is at its line limit.', 'No:');
      return;
    }
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
    // The library is in front of everything, so it goes first.
    if (!$('sheet').hidden) {
      closeSheet();
      return;
    }
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
  if (state.patch.nodes.length >= LIMITS.nodes) {
    governor.trip('patch', audio.now(), `${LIMITS.nodes} nodes is the limit`);
    return;
  }
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
  setStatus(`Saved as ${a.download}. Drop that file on any Gridi canvas to open it.`, 'Patch.');
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    openPatch(deserialize(await file.text(), onPatchLimit), file.name);
  } catch {
    setStatus('That file could not be read as a patch.', 'Sorry:');
  }
  e.target.value = '';
});

/* ------------------------------------------------------------- open a patch */

/**
 * Take a patch that arrived from outside: a file, a drop, a paste.
 *
 * It replaces what is on the canvas, so it goes through the undo stack --
 * dropping the wrong file on a patch you have been working on should cost one
 * keystroke to put right, not the afternoon.
 */
function openPatch(patch, from = '') {
  snapshot();
  loadPatch(patch, { keepHistory: true });
  const named = patch.name && patch.name !== 'Untitled' ? `“${patch.name}”` : from || 'that patch';
  setStatus(`${named} is on the canvas. ⌘Z puts back what was here.`, 'Opened.');
}

/**
 * Anything dragged onto the stage, or pasted into it.
 *
 * A file is read for its text; a drag from a browser or an editor arrives as
 * text already. Either way it has to look like a patch before it is allowed to
 * replace one, so dropping a photo on the canvas does nothing rather than
 * wiping the work.
 */
async function openFromTransfer({ file, text }) {
  if (file && /\.sf[23]$/i.test(file.name)) {
    if (/\.sf3$/i.test(file.name)) {
      setStatus('That is a compressed SoundFont. Gridi reads .sf2.', 'Sorry:');
      return false;
    }
    await useSoundfontFile(await file.arrayBuffer(), file.name);
    return true;
  }
  const body = file ? await file.text() : text;
  const patch = body ? readPatch(body, onPatchLimit) : null;
  if (!patch) {
    setStatus(
      file
        ? `${file.name} is neither a Gridi patch nor a SoundFont.`
        : 'That is not a Gridi patch. Save one with Save, and drop the file back here.',
      'Nothing opened.',
    );
    return false;
  }
  openPatch(patch, file?.name);
  return true;
}

/* --------------------------------------------------------------- library */

/**
 * The patches that ship with Gridi, listed in `patches/index.json`.
 *
 * They are ordinary patch files, opened by the same path as a dropped one --
 * there is nothing a library patch can do that a saved one cannot. Fetched on
 * first use and kept, because the list does not change while the page is open.
 */
let library = null;

async function loadLibrary() {
  if (library) return library;
  const res = await fetch('patches/index.json');
  if (!res.ok) throw new Error(`index ${res.status}`);
  const raw = await res.json();
  library = Array.isArray(raw.patches) ? raw.patches : [];
  return library;
}

async function openLibraryPatch(entry) {
  const res = await fetch(`patches/${entry.file}`);
  if (!res.ok) throw new Error(`${entry.file} ${res.status}`);
  const patch = readPatch(await res.text(), onPatchLimit);
  if (!patch) throw new Error(`${entry.file} is not a patch`);
  closeSheet();
  openPatch(patch, entry.name);
}

function closeSheet() {
  $('sheet').hidden = true;
}

/** Open the panel on one thing, or close it if that thing is already up. */
function toggleSheet(title, fill) {
  const sheet = $('sheet');
  if (!sheet.hidden && sheet.dataset.showing === title) {
    closeSheet();
    return;
  }
  sheet.dataset.showing = title;
  $('sheet-title').textContent = title;
  $('sheet-list').textContent = '';
  sheet.hidden = false;
  fill($('sheet-list'));
}

async function showLibrary(list) {
  try {
    const entries = await loadLibrary();
    if (!entries.length) {
      list.append(Object.assign(document.createElement('p'), {
        className: 'sheet__note',
        textContent: 'Nothing in the library yet.',
      }));
      return;
    }
    for (const entry of entries) {
      const item = document.createElement('button');
      item.className = 'sheet__item';
      item.append(Object.assign(document.createElement('b'), { textContent: entry.name }));
      if (entry.note) {
        item.append(Object.assign(document.createElement('span'), { textContent: entry.note }));
      }
      item.addEventListener('click', () => {
        openLibraryPatch(entry).catch(() => {
          setStatus(`${entry.name} could not be opened.`, 'Sorry:');
          closeSheet();
        });
      });
      list.append(item);
    }
    list.firstChild?.focus();
  } catch {
    list.textContent = '';
    list.append(Object.assign(document.createElement('p'), {
      className: 'sheet__note',
      textContent: 'The library could not be read. Gridi has to be served over http, not opened as a file.',
    }));
  }
}

$('library').addEventListener('click', () => toggleSheet('library', showLibrary));

/* ------------------------------------------------------------- soundfont */

/** "34 sounds", or "1 sound", because the difference is always noticed. */
const describe = (font) => `${font.presetCount} sound${font.presetCount === 1 ? '' : 's'}`;

/** A file size somebody would say out loud. */
const size = (bytes) => (bytes >= 1e6 ? `${Math.round(bytes / 1e6)}MB` : `${Math.round(bytes / 1e3)}KB`);

/**
 * Take a SoundFont file.
 *
 * Parsing is the cheap part -- it builds an index and never touches the sample
 * block -- so even a hundred-megabyte General MIDI font is ready by the time
 * the file has been read. Keeping it is separate and allowed to fail: a font
 * that will not fit in storage still plays, it just has to be dropped again
 * next time.
 */
async function useSoundfontFile(bytes, name, { keep = true } = {}) {
  let font;
  try {
    font = new SoundFont(bytes, name);
  } catch (err) {
    setStatus(`${name} could not be read as a SoundFont.`, 'Sorry:');
    return null;
  }
  audio.useSoundfont(font);
  const has = describe(font);
  if (!keep) {
    setStatus(`${font.label}, ${has}. Patches play through it.`, 'SoundFont.');
    return font;
  }
  const kept = await keepSoundfont(bytes, name);
  setStatus(
    kept
      ? `${font.label}, ${has}, ${size(font.bytes)}. Kept for next time.`
      : `${font.label}, ${has}. Too big to keep, so drop it again next time.`,
    'SoundFont.',
  );
  if (!$('sheet').hidden && $('sheet').dataset.showing === 'sounds') showSounds($('sheet-list'));
  return font;
}

/** The font from last time, if there was one. */
async function recallFont() {
  const held = await recallSoundfont();
  if (!held) return;
  await useSoundfontFile(held.bytes, held.name, { keep: false });
}

/* ----------------------------------------------------------------- sounds */

/**
 * What each channel of this patch should be playing.
 *
 * The rows are the channels the patch actually plays on, worked out from the
 * graph, so there is never a row for a channel nothing reaches. Choosing a
 * sound writes a program number into the patch; the transport sends it on the
 * way in, and anything receiving is on the right sound before the first note.
 */
function showSounds(list) {
  const font = audio.soundfont;
  const banner = document.createElement('p');
  banner.className = 'sheet__note';
  if (font) {
    banner.textContent = `Playing through ${font.label}, ${describe(font)}. `;
    const drop = document.createElement('button');
    drop.className = 'sheet__link';
    drop.textContent = 'forget it';
    drop.addEventListener('click', async () => {
      audio.useSoundfont(null);
      await forgetSoundfont();
      setStatus('SoundFont dropped. Notes are back to the built-in blip.', 'Sounds.');
      showSounds(list);
    });
    banner.append(drop);
  } else {
    banner.textContent = 'No SoundFont. Drop a .sf2 on the canvas to hear these sounds.';
  }
  list.append(banner);

  const channels = usedChannels(state.patch);
  if (!channels.length) {
    list.append(Object.assign(document.createElement('p'), {
      className: 'sheet__note',
      textContent: 'Nothing is playing yet. Patch a Note node up and its channel appears here.',
    }));
    return;
  }

  for (const { out, ch } of channels) {
    const row = document.createElement('div');
    row.className = 'sheet__row';
    row.append(Object.assign(document.createElement('span'), {
      textContent: ch === DRUM_CHANNEL ? `${out} · ch ${ch} · drums` : `${out} · ch ${ch}`,
    }));

    const pick = document.createElement('select');
    pick.className = 'field';
    pick.setAttribute('aria-label', `Sound for output ${out} channel ${ch}`);
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— leave as it is —';
    pick.append(none);
    for (const { value, label } of programsFor(ch)) {
      const opt = document.createElement('option');
      opt.value = String(value);
      opt.textContent = `${String(value).padStart(3, ' ')}  ${label}`;
      pick.append(opt);
    }
    const current = soundFor(state.patch, out, ch);
    pick.value = current === null ? '' : String(current);
    pick.addEventListener('change', () => {
      const program = pick.value === '' ? null : Number(pick.value);
      setSound(state.patch, out, ch, program);
      save();
      if (program === null) {
        setStatus(`${out} channel ${ch} is left on whatever the device has.`, 'Sound.');
        return;
      }
      // Send it now as well as at the next start, so the change is audible
      // while you are choosing rather than only after pressing play.
      midi.sendProgram({ slot: out, channel: ch, program, at: audio.now() });
      setStatus(`${out} channel ${ch} is ${programName(program, ch)}.`, 'Sound.');
    });
    row.append(pick);
    list.append(row);
  }

  list.append(Object.assign(document.createElement('p'), {
    className: 'sheet__note',
    textContent: 'General MIDI program numbers, sent when the transport starts.',
  }));
}

$('sounds').addEventListener('click', () => toggleSheet('sounds', showSounds));
$('sheet-close').addEventListener('click', closeSheet);

/*
 * Drag and drop. The counter is because dragenter and dragleave both fire for
 * every child element the pointer crosses, so a single boolean flickers the
 * overlay on and off as the file moves across the stage.
 */
const stage = document.querySelector('.stage');
let dragDepth = 0;

function showDrop(on) {
  $('drop').hidden = !on;
}

function carriesFile(e) {
  return [...(e.dataTransfer?.types ?? [])].some((t) => t === 'Files' || t === 'text/plain');
}

stage.addEventListener('dragenter', (e) => {
  if (!carriesFile(e)) return;
  e.preventDefault();
  dragDepth += 1;
  showDrop(true);
});

stage.addEventListener('dragover', (e) => {
  if (!carriesFile(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

stage.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showDrop(false);
});

stage.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  showDrop(false);
  const file = e.dataTransfer?.files?.[0];
  const text = e.dataTransfer?.getData('text/plain');
  if (!file && !text) return;
  await openFromTransfer({ file, text });
});

/*
 * Paste. How a patch shared in a chat window actually arrives: as the text of
 * the file rather than the file. Typing into a field is left alone.
 */
document.addEventListener('paste', async (e) => {
  const target = e.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  const text = e.clipboardData?.getData('text/plain');
  if (!text || !text.trim().startsWith('{')) return;
  if (await openFromTransfer({ text })) e.preventDefault();
});

$('clock-out').addEventListener('click', () => {
  state.patch.clockOut = state.patch.clockOut === false;
  syncHeader();
  syncMidi();
  save();
  setStatus(
    state.patch.clockOut
      ? 'Sending MIDI clock, start and stop — receiving gear can follow this tempo.'
      : 'MIDI clock off. Notes still go out; nothing will follow the tempo.',
    'Clock.',
  );
});
$('guard-close').addEventListener('click', hideGuard);
$('play').addEventListener('click', toggleTransport);
// The name is what a shared patch is called on the other person's canvas, and
// what the saved file is called on this one.
$('patch-name').addEventListener('input', () => {
  state.patch.name = $('patch-name').value.trim() || 'Untitled';
  save();
});

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
  $('theme').textContent = next === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore */
  }
  renderer.readColors();
});

/* --------------------------------------------------------------------- MIDI */

/** Which slot the header controls are editing. */
let editingSlot = SLOTS[0];

function buildSlotPicker() {
  const holder = $('slot-picker');
  holder.innerHTML = '';
  for (const slot of SLOTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = slot;
    btn.title = `Output ${slot}`;
    btn.addEventListener('click', () => {
      editingSlot = slot;
      syncMidi();
    });
    holder.append(btn);
  }
}

function syncMidi() {
  for (const [i, btn] of [...$('slot-picker').children].entries()) {
    const slot = SLOTS[i];
    btn.setAttribute('aria-pressed', String(slot === editingSlot));
    btn.classList.toggle('slot--bound', Boolean(midi.portFor(slot)));
    const device = midi.deviceName(slot);
    btn.title = device ? `Output ${slot}: ${device}` : `Output ${slot}: nothing bound`;
  }

  const picker = $('midi-out');
  picker.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— none —';
  picker.append(none);
  for (const out of midi.outputs) {
    const opt = document.createElement('option');
    opt.value = out.id;
    opt.textContent = out.manufacturer ? `${out.name} — ${out.manufacturer}` : out.name;
    picker.append(opt);
  }
  picker.disabled = midi.outputs.length === 0;
  picker.value = midi.slots.get(editingSlot)?.portId ?? '';

  const clockBtn = $('slot-clock');
  clockBtn.textContent = `clk ${editingSlot}`;
  clockBtn.setAttribute('aria-pressed', String(midi.sendsClock(editingSlot)));
  clockBtn.disabled = state.patch.clockOut === false;
  clockBtn.title = `Send clock to output ${editingSlot}`;

  const btn = $('midi-enable');
  const bound = midi.boundSlots.length;
  if (midi.status === 'ready') {
    btn.textContent = bound > 1 ? `MIDI \u00d7${bound}` : 'MIDI on';
    btn.setAttribute('aria-pressed', 'true');
  } else if (midi.status === 'no-ports') {
    btn.textContent = 'no ports';
    btn.setAttribute('aria-pressed', 'false');
  } else {
    btn.textContent = 'enable MIDI';
    btn.setAttribute('aria-pressed', 'false');
  }
  saveOutputs();
}

function saveOutputs() {
  try {
    localStorage.setItem(OUTPUTS_KEY, JSON.stringify(midi.bindings()));
  } catch {
    /* private mode, or quota */
  }
}

function restoreOutputs() {
  try {
    const stored = localStorage.getItem(OUTPUTS_KEY);
    if (stored) midi.restoreBindings(JSON.parse(stored));
  } catch {
    /* ignore */
  }
}

midi.onChange = syncMidi;
midiIn.onChange = syncMidiIn;
midiIn.onClock = (at) => engine.externalClock(at);
midiIn.onStart = () => engine.externalStart();
midiIn.onContinue = () => engine.externalContinue();
midiIn.onStop = () => engine.externalStop();
midiIn.onPosition = (sixteenths) => engine.externalPosition(sixteenths);
midiIn.onNote = (played) => {
  state.lastPlayed = played;
  if (engine.externalNote(played) === 0 && state.patch.nodes.every((n) => n.type !== 'input')) {
    setStatus('A note arrived, but the patch has no MIDI In node to receive it.', 'Heard:');
  }
};

function syncMidiIn() {
  const picker = $('midi-in');
  picker.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '\u2014 none \u2014';
  picker.append(none);
  for (const device of midiIn.inputs) {
    const opt = document.createElement('option');
    opt.value = device.id;
    opt.textContent = device.name;
    picker.append(opt);
  }
  picker.disabled = midiIn.inputs.length === 0;
  picker.value = midiIn.inputId ?? '';
  const btn = $('sync-ext');
  const external = state.patch.sync === 'external';
  btn.setAttribute('aria-pressed', String(external));
  btn.disabled = !midiIn.enabled;
  btn.title = external
    ? 'Following the incoming MIDI clock'
    : 'Follow the incoming MIDI clock instead of the project tempo';
}

$('midi-enable').addEventListener('click', async () => {
  const ok = await midi.enable();
  if (ok && midi.outputs.length) {
    restoreOutputs();
    midiIn.attach(midi.access);
    const bound = midi.boundSlots.map((s) => `${s}: ${midi.deviceName(s)}`).join(' · ');
    setStatus(`${bound}. Pick A–D to bind the others.`, 'MIDI ready.');
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

$('midi-in').addEventListener('change', (e) => {
  midiIn.setInput(e.target.value || null);
  const name = midiIn.deviceName();
  setStatus(name ? `Listening to ${name}.` : 'Not listening to anything.', 'MIDI in.');
});

$('sync-ext').addEventListener('click', () => {
  state.patch.sync = state.patch.sync === 'external' ? 'internal' : 'external';
  if (state.patch.sync === 'internal') {
    engine.follower.reset();
    engine.setBpm(state.patch.bpm);
  }
  syncHeader();
  save();
  setStatus(
    state.patch.sync === 'external'
      ? 'Following the incoming clock. Start the master to begin.'
      : 'Back on the project tempo.',
    'Sync.',
  );
});

$('midi-out').addEventListener('change', (e) => {
  midi.bind(editingSlot, e.target.value || null);
  const name = midi.deviceName(editingSlot);
  setStatus(
    name ? `Output ${editingSlot} goes to ${name}.` : `Output ${editingSlot} is not bound to anything.`,
    'MIDI.',
  );
});

$('slot-clock').addEventListener('click', () => {
  midi.setSlotClock(editingSlot, !midi.sendsClock(editingSlot));
  setStatus(
    midi.sendsClock(editingSlot)
      ? `Output ${editingSlot} receives clock.`
      : `Output ${editingSlot} will not receive clock.`,
    'Clock.',
  );
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

  // What one cell of the grid is worth. Changing it retimes every line in the
  // patch at once and closes up the bar rules to match.
  const grid = $('grid');
  for (const key of GRID_KEYS) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = key;
    grid.append(opt);
  }
  grid.addEventListener('change', () => {
    state.patch.grid = grid.value;
    setStatus(`a cell is now ${grid.value} — every line in the patch is retimed.`, 'Grid:');
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
    if (state.patch.sync === 'external' && document.activeElement !== $('bpm')) {
      $('bpm').value = String(Math.round(engine.bpm));
    }
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
      $('theme').textContent = 'light';
    }
  } catch {
    /* ignore */
  }
  renderer.readColors();

  populateKeySelects();
  // The font from last time, if there was one. Nothing waits on it: a patch is
  // playable before it arrives, and louder afterwards.
  recallFont();
  showEnvironmentWarning();
  buildSlotPicker();
  syncMidi();
  syncMidiIn();

  let initial = null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) initial = deserialize(stored, onPatchLimit);
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
export { state, audio, midi, midiIn, engine, renderer };
