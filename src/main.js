// Application wiring: input, transport, persistence, and the frame loop.

import { AudioEngine } from './audio.js';
import { MidiOut, MIDI_SUPPORTED, SLOTS } from './midi.js';
import { MidiIn } from './midi-in.js';
import { Engine, TICK_MS } from './engine.js';
import { Renderer, keyName } from './render.js';
import { Inspector, buildPalette } from './ui.js';
import {
  createPatch, createNode, addNode, removeNode, removeLine, connect, canConnect,
  demoPatch, OPENING_PATCH, serialize, deserialize, readPatch, nodeById, usedChannels, soundFor, setSound,
} from './model.js';
import { programName, programsFor, DRUM_CHANNEL } from './gm.js';
import { readShelf, writeShelf, keepPatch, removePatch, copyName, indexOfName } from './shelf.js';
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
import { appMarkup } from './markup.js';

const BASE_STORAGE_KEY = 'gridi.patch.v1';
const BASE_THEME_KEY = 'gridi.theme';
// Device bindings live on the machine, not in the patch: a patch names output
// slots, and each machine decides what sits behind them.
const BASE_OUTPUTS_KEY = 'gridi.outputs.v1';
const MAX_HISTORY = 60;

/**
 * How far out the view goes.
 *
 * It used to stop at 0.32, which was about where a node stops being readable —
 * a fair floor for the wheel, and the wrong one for a fit: a patch the size of
 * Bossa Nova in a stage the size of an embed needs 0.29 to be seen whole, and
 * what the floor bought was a legible node with the rest of the patch off the
 * edge. Seeing all of it is the point of a fit, so the floor went down to
 * where the shape of a patch still reads even when its labels do not.
 */
const ZOOM_MIN = 0.2;

/**
 * An asset that ships beside the app, wherever the app was loaded from.
 *
 * A bare `fetch('soundfont/index.json')` resolves against the *document*,
 * which is gridi's own page standalone and somebody else's note embedded — so
 * the embed went looking for the soundfont on the host's site, where it has
 * never been. Resolved against this module instead, both cases land on the
 * deploy the code itself came from.
 */
const asset = (path) => new URL(`../${path}`, import.meta.url).href;


/**
 * One running copy of gridi.
 *
 * Everything below used to run when this module was imported, against the
 * document. It runs against a mount now, once `initGridi` is called with one,
 * because there are two ways to run gridi: its own page, and embedded in a
 * note on bobbymeyer.com. A module that boots itself can only ever be the
 * first of those.
 *
 * `mount` is the element the app is built into. Every lookup is scoped to it,
 * so an embedded copy cannot collect the host page's elements, nor it theirs.
 */
let mount = null;

/** The running instance, or null. There is at most one per document. */
let live = null;

/** Where the theme attribute goes: the page standalone, the mount embedded. */
let themeHost = null;

export function initGridi(mountEl, options = {}) {
  if (live) return live;
  if (!mountEl) throw new Error('gridi: initGridi needs an element to build into');

  mount = mountEl;
  mount.classList.add('gridi-root');
  mount.innerHTML = appMarkup({ mark: options.mark !== false });

  // Embedded, the theme belongs to the mount: setting it on the page would
  // hand the host site gridi's palette. Standalone they are the same element
  // in every way that matters.
  themeHost = options.embedded ? mount : document.documentElement;

  /** Running inside somebody else's page, rather than on gridi's own. */
  const embedded = Boolean(options.embedded);

  // Namespaced, so a patch played inside somebody's note cannot overwrite the
  // one being worked on at the real thing. Same app, different desk.
  const ns = options.storagePrefix ?? '';
  const STORAGE_KEY = ns + BASE_STORAGE_KEY;
  const THEME_KEY = ns + BASE_THEME_KEY;
  const OUTPUTS_KEY = ns + BASE_OUTPUTS_KEY;
  const SHELF_KEY = ns + 'gridi.shelf.v1';

  // Inside a shadow root the document reports the host as focused, not the
  // field the reader is actually typing in.
  const activeEl = () => mount.getRootNode().activeElement ?? document.activeElement;

  /**
   * Whether the keyboard, the wheel and the clipboard are gridi's to take.
   *
   * On its own page they always are. Embedded in a note they are not: the
   * reader is reading, and a page where space starts a sequencer instead of
   * scrolling it, where ⌘S offers a patch instead of the page, and where the
   * wheel stops dead over the middle of the article, is a page that one of its
   * figures has taken over. So embedded, gridi answers the keyboard once
   * somebody has clicked into it, and gives it straight back when they click
   * out. Nothing changes on its own page, where clicking in is arriving.
   */
  const hasFocus = () => !embedded || mount.contains(activeEl());

  /**
   * How the footer opens. Embedded, space is not gridi's until it is clicked
   * into, so saying "press space" to somebody who has not is a lie.
   */
  const READY_HINT = embedded ? 'Click the grid, then space plays.' : 'Press play, or space.';

  // Listeners on window and document outlive the mount, so they are kept and
  // taken off again. Everything else is bound to elements inside the mount and
  // goes when it does.
  const outside = [];
  const onOutside = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    outside.push([target, type, fn, opts]);
  };

  let raf = null;
  let ro = null;

  const $ = (id) => mount.querySelector('#' + CSS.escape(id));

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
  }), themeHost);

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
      ZOOM_MIN,
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
    // Picking something is asking what it is, and a folded inspector answers
    // with a strip of type down the edge. Deselecting leaves it as it is:
    // clicking empty grid is not a request to give the canvas its width back.
    if (kind !== 'none' && mount.dataset.pane === 'min') setPane(true);
    inspector.show(state.patch, state.selection);
    syncHeader();
  }

  /* ------------------------------------------------------------ transport UI */

  let ticker = null;

  /**
   * Whether the reader has taken the view for themselves.
   *
   * Embedded, gridi is laid out twice: once bare, and again when the
   * stylesheet arrives and the stage finally has the size it will keep. A fit
   * computed against the first of those is a fit against a box that never
   * existed — which is how the patch came to sit clipped along the top of the
   * note. So the fit follows the canvas while the view is still gridi's own,
   * and stops the moment somebody pans or zooms, because after that the view
   * is theirs and nothing is entitled to move it.
   */
  let viewIsTheirs = false;

  async function play() {
    // The first press of play is the first time anybody has asked to hear
    // something, which is when the bundled font is worth its download.
    wantFont();
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
    // Clicking the grid is how the app is asked for the keyboard when it is
    // embedded, and how tabbing back to it lands somewhere sensible otherwise.
    // The mark says the focus came from a pointer: a script calling focus()
    // counts as :focus-visible in Chromium, and a blue ring around the canvas
    // on every click is not what that ring is for.
    canvas.dataset.pointer = '';
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    // Once somebody is working on the grid, nothing else may move the view.
    // The fit that follows the canvas is for the seconds before that — an
    // embed laid out twice while its stylesheet arrives — and a click that
    // opens the inspector would otherwise refit the patch under the pointer
    // that clicked it.
    viewIsTheirs = true;
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

  canvas.addEventListener('blur', () => {
    delete canvas.dataset.pointer;
  });

  canvas.addEventListener('pointermove', (e) => {
    const world = pointerWorld(e);
    const drag = state.drag;

    if (drag?.kind === 'pan') {
      viewIsTheirs = true;
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
      // Embedded and not clicked into: this is the reader scrolling the page
      // the app happens to be sitting in, so let it scroll.
      if (!hasFocus()) return;
      e.preventDefault();
      viewIsTheirs = true;
      const view = state.patch.view;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const before = screenToWorld({ x: sx, y: sy }, view);
      const factor = Math.exp(-e.deltaY * 0.0014);
      view.zoom = clamp(view.zoom * factor, ZOOM_MIN, 2.6);
      const after = screenToWorld({ x: sx, y: sy }, view);
      view.x += after.x - before.x;
      view.y += after.y - before.y;
    },
    { passive: false },
  );

  /* ---------------------------------------------------------------- keyboard */

  const typing = () => {
    const el = activeEl();
    return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
  };

  onOutside(window, 'keydown', (e) => {
    if (!hasFocus()) return;
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
      if (e.key === 'Escape') activeEl().blur();
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
    const res = await fetch(asset('patches/index.json'));
    if (!res.ok) throw new Error(`index ${res.status}`);
    const raw = await res.json();
    library = Array.isArray(raw.patches) ? raw.patches : [];
    return library;
  }

  async function libraryPatch(entry) {
    const res = await fetch(asset(`patches/${entry.file}`));
    if (!res.ok) throw new Error(`${entry.file} ${res.status}`);
    const patch = readPatch(await res.text(), onPatchLimit);
    if (!patch) throw new Error(`${entry.file} is not a patch`);
    return patch;
  }

  async function openLibraryPatch(entry) {
    const patch = await libraryPatch(entry);
    closeSheet();
    openPatch(patch, entry.name);
  }

  /**
   * What is on the grid the first time somebody arrives.
   *
   * Bossa Nova, out of the library rather than out of the source. A reader who
   * has never seen gridi should meet a patch that is doing the thing the app is
   * for — a clave written as distance, five lines of different lengths off one
   * clock — and it should be the same file the library hands out, not a second
   * copy of it that drifts the first time the rhythm is touched.
   *
   * The library is fetched, and a fetch can fail: opened off a file:// URL
   * there is no library at all. The built-in demo is the floor under that, and
   * it is a working patch too.
   */
  async function openingPatch() {
    try {
      const entries = await loadLibrary();
      const entry = entries.find((e) => e.file === OPENING_PATCH) ?? entries[0];
      if (!entry) throw new Error('the library is empty');
      const patch = await libraryPatch(entry);
      // Somebody who started building in the moment it took to arrive keeps
      // what they built: the opening patch is only ever for an empty grid.
      if (state.patch.nodes.length) return;
      loadPatch(patch);
      inspector.show(state.patch, state.selection);
      setStatus(`${entry.name}. ${READY_HINT}`, 'Ready.');
    } catch {
      if (state.patch.nodes.length) return;
      loadPatch(demoPatch());
      inspector.show(state.patch, state.selection);
    }
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

  /**
   * The library, along the header.
   *
   * It was a panel over the canvas, which is the shape for a thing you open,
   * read and shut again. A shelf is not that: it is looked along, and what is
   * on it should be visible at the same time as the patch it would replace.
   * Filled once, the first time the tab is asked for — the index is fetched
   * for the opening patch anyway, so by then it is usually in hand already.
   * Above it on the same tab is the patch itself: its name, and saving,
   * opening and starting one. What a patch is and which patch it is are the
   * same question, and they were two rules apart.
   */
  /* --------------------------------------------------------------- shelves */

  /**
   * What is kept in this browser.
   *
   * Gridi ships five patches and remembers exactly one thing you are working
   * on. Everything between those — Tuesday's sketch, a copy of Bossa Nova with
   * the clave moved — had nowhere to live but a downloaded file. The shelf is
   * that middle. It is this browser's and nothing else's: saving a file is
   * still how a patch leaves the machine.
   */
  let shelf = [];

  /**
   * Write the shelf, and say so if it will not go.
   *
   * Storage is the one thing here that can refuse, and a patch somebody thinks
   * they kept and did not is worse than one they know they did not.
   */
  function keepShelf(next) {
    try {
      localStorage.setItem(SHELF_KEY, writeShelf(next));
    } catch {
      setStatus('No room left in this browser. Take a patch off the shelf, or save it as a file.', 'Sorry:');
      return false;
    }
    shelf = next;
    fillMine($('mine'));
    return true;
  }

  /** "kept 23 Sep", which is all a shelf needs to say about when. */
  const kept = (at) =>
    at ? `kept ${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '';

  /**
   * One patch on a shelf: what it is, and the one thing besides opening it that
   * can be done to it.
   *
   * The open half is a button and so is the act, which is why the cell around
   * them is not one — a button inside a button is not something a browser will
   * build.
   */
  function shelfCell({ name, blurb, title, onOpen, actLabel, actTitle, actClass = '', onAct }) {
    const item = document.createElement('div');
    item.className = 'library__item';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'library__open';
    open.append(Object.assign(document.createElement('b'), { textContent: name }));
    if (blurb) open.append(Object.assign(document.createElement('span'), { textContent: blurb }));
    if (title) open.title = title;
    open.addEventListener('click', onOpen);

    const act = document.createElement('button');
    act.type = 'button';
    act.className = `library__act ${actClass}`.trim();
    act.textContent = actLabel;
    act.title = actTitle;
    act.addEventListener('click', onAct);

    item.append(open, act);
    return item;
  }

  const shelfNote = (text) => Object.assign(document.createElement('p'), {
    className: 'library__note',
    textContent: text,
  });

  /**
   * The patches gridi ships with, along the header.
   *
   * It was a panel over the canvas, which is the shape for a thing you open,
   * read and shut again. A shelf is not that: it is looked along, and what is
   * on it should be visible at the same time as the patch it would replace.
   * Filled once, the first time the tab is asked for — the index is fetched
   * for the opening patch anyway, so by then it is usually in hand already.
   * Above it on the same tab is the patch itself: its name, and saving,
   * opening and starting one. What a patch is and which patch it is are the
   * same question, and they were two rules apart.
   */
  async function fillLibrary(row) {
    row.textContent = '';

    let entries;
    try {
      entries = await loadLibrary();
    } catch {
      row.append(shelfNote('The library could not be read. Gridi has to be served over http, not opened as a file.'));
      return;
    }

    if (!entries.length) {
      row.append(shelfNote('Nothing in the library yet.'));
      return;
    }

    for (const entry of entries) {
      row.append(shelfCell({
        name: entry.name,
        // The blurb is clamped to two lines in the strip; the whole of it is
        // one hover away.
        blurb: entry.note,
        title: entry.note,
        onOpen: () => {
          openLibraryPatch(entry).catch(() => {
            setStatus(`${entry.name} could not be opened.`, 'Sorry:');
          });
        },
        actLabel: '+',
        actTitle: `Copy ${entry.name} to your shelf`,
        onAct: () => copyToShelf(entry),
      }));
    }
  }

  /** The kept ones, newest first, under the ones that ship. */
  function fillMine(row) {
    row.textContent = '';

    if (!shelf.length) {
      row.append(shelfNote('Nothing yet. Keep puts what is on the grid here; + on a patch above puts a copy of that one.'));
      return;
    }

    for (const entry of shelf) {
      row.append(shelfCell({
        name: entry.name,
        blurb: kept(entry.saved),
        title: entry.saved ? `Kept ${new Date(entry.saved).toLocaleString()}` : '',
        onOpen: () => openKept(entry),
        actLabel: '\u00d7',
        actTitle: `Take ${entry.name} off your shelf`,
        actClass: 'library__act--off',
        onAct: (e) => askRemove(e.currentTarget.closest('.library__item'), entry),
      }));
    }
  }

  function openKept(entry) {
    const patch = readPatch(entry.patch, onPatchLimit);
    if (!patch) {
      setStatus(`“${entry.name}” could not be read, and has been left where it is.`, 'Sorry:');
      return;
    }
    openPatch(patch, entry.name);
  }

  /** Keep what is on the grid, under whatever it is called. */
  function keepCurrent() {
    const name = state.patch.name?.trim() || 'Untitled';
    const had = indexOfName(shelf, name) !== -1;
    if (!keepShelf(keepPatch(shelf, name, serialize(state.patch)))) return;
    setStatus(
      had ? `“${name}” replaces the one that was on your shelf.` : `“${name}” is on your shelf.`,
      'Kept.',
    );
  }

  /** A patch that ships, copied onto the shelf under a name of its own. */
  async function copyToShelf(entry) {
    let patch;
    try {
      patch = await libraryPatch(entry);
    } catch {
      setStatus(`${entry.name} could not be copied.`, 'Sorry:');
      return;
    }
    patch.name = copyName(entry.name, shelf);
    // The canvas is left alone: copying is not opening, and somebody halfway
    // through a patch did not ask for it to be replaced.
    if (keepShelf(keepPatch(shelf, patch.name, serialize(patch)))) {
      setStatus(`“${patch.name}” is on your shelf. Click it to open it.`, 'Copied.');
    }
  }

  /**
   * Taking a patch off the shelf is the one thing here that cannot be undone,
   * so it asks first — in the cell itself, rather than in a dialog that an
   * embedded copy would throw across somebody's page.
   */
  function askRemove(item, entry) {
    item.textContent = '';
    item.classList.add('library__item--asking');
    // The cell is too narrow for the name and the question both, and the cell
    // is where the name was a moment ago.
    item.title = `Take “${entry.name}” off your shelf?`;
    item.append(Object.assign(document.createElement('span'), { textContent: 'remove?' }));

    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'library__act library__act--off';
    yes.textContent = 'yes';
    yes.addEventListener('click', () => {
      if (keepShelf(removePatch(shelf, entry.name))) {
        setStatus(`“${entry.name}” is off your shelf.`, 'Removed.');
      }
    });

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'library__act';
    no.textContent = 'no';
    no.addEventListener('click', () => fillMine($('mine')));

    item.append(yes, no);
    yes.focus();
  }

  $('keep').addEventListener('click', keepCurrent);

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

  /**
   * The bundled font, as `soundfont/index.json` describes it. Read once.
   */
  let bundled = null;
  async function bundledFont() {
    if (bundled) return bundled;
    const res = await fetch(asset('soundfont/index.json'));
    if (!res.ok) throw new Error(`soundfont index ${res.status}`);
    bundled = await res.json();
    return bundled;
  }

  /**
   * The font to start with: the one dropped in last time, if there was one.
   *
   * Nothing waits on this, and nothing is fetched for it. What ships with gridi
   * is thirty-two megabytes, and it used to be pulled down on boot — so a note
   * that merely *mentions* the sequencer cost every reader thirty-two megabytes
   * before they had asked to hear a thing. It is fetched on the first press of
   * play now, by `wantFont` below, where somebody has asked.
   */
  async function startingFont() {
    const held = await recallSoundfont();
    if (held) await useSoundfontFile(held.bytes, held.name, { keep: false });
  }

  /** The fetch of the bundled font, once it has been asked for. */
  let fontWanted = null;

  /**
   * Ask for the sounds, if there are none yet.
   *
   * Not awaited by its caller: the transport starts on the beat it was pressed
   * and the notes it sends before the font lands go to the built-in voices and
   * to MIDI, which is most of what gridi is for. The sound fills in underneath.
   */
  function wantFont() {
    if (audio.soundfont || fontWanted) return fontWanted;
    fontWanted = (async () => {
      try {
        const entry = await bundledFont();
        const res = await fetch(asset(`soundfont/${entry.file}`));
        if (!res.ok) throw new Error(`${entry.file} ${res.status}`);
        // Said before the body arrives, and said with the number, because the
        // number is the reason the wait is worth explaining.
        const length = Number(res.headers.get('content-length')) || 0;
        setStatus(`Loading ${entry.name}${length ? `, ${size(length)}` : ''}…`, 'SoundFont.');
        // Not kept in storage: it is on disk beside the app already, and putting
        // a second copy in the browser's quota would only crowd out a font
        // someone actually chose.
        const font = await useSoundfontFile(await res.arrayBuffer(), entry.file, { keep: false });
        if (font) {
          setStatus(`${entry.name} by ${entry.author}, ${describe(font)}. Ready.`, 'SoundFont.');
        }
      } catch {
        fontWanted = null;
        setStatus('No SoundFont. Drop a .sf2 on the canvas to hear these sounds.', '');
      }
    })();
    return fontWanted;
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
  async function showSounds(list) {
    // Cleared here as well as by the panel, because this redraws itself after
    // a font is taken or dropped and appending would give it two of everything.
    list.textContent = '';
    const font = audio.soundfont;
    const banner = document.createElement('p');
    banner.className = 'sheet__note';
    if (font) {
      banner.textContent = `Playing through ${font.label}, ${describe(font)}.`;
      // Whose work this is, where the sound is chosen. The bundled font is
      // somebody's years of recording; a line of credit is the least of it.
      if (bundled && font.label.startsWith(bundled.name)) {
        banner.append(document.createElement('br'));
        banner.append(`by ${bundled.author} — `);
        const link = document.createElement('a');
        link.href = bundled.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = bundled.url.replace(/^https?:\/\//, '');
        banner.append(link, ' ');
      } else {
        banner.append(' ');
      }
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
      banner.textContent = 'No SoundFont yet — drop a .sf2 on the canvas, or ';
      // The bundled font is not fetched until somebody asks, and this is the
      // other place they can ask. What it costs is said in the footer as the
      // download starts, from the response's own length.
      const entry = await bundledFont().catch(() => null);
      if (entry) {
        const take = document.createElement('button');
        take.className = 'sheet__link';
        take.textContent = `load ${entry.name}`;
        take.addEventListener('click', async () => {
          take.disabled = true;
          await wantFont();
          showSounds(list);
        });
        banner.append(take, '.');
      } else {
        banner.textContent = 'No SoundFont. Drop a .sf2 on the canvas to hear these sounds.';
      }
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
  const stage = mount.querySelector('.stage');
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
  onOutside(document, 'paste', async (e) => {
    if (!hasFocus()) return;
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

  /* --------------------------------------------------------------- chrome */

  const remember = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* a browser with storage switched off still runs, it just forgets */
    }
  };

  const recall = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  /**
   * The header's two tabs.
   *
   * What a patch is — its tempo, what a cell is worth, what key it is in — is
   * saved in the file and travels with it. What it is being played on is not:
   * the ports belong to the desk, and change when the desk does. They had been
   * laid out along one header as though they were the same kind of thing.
   */
  const TABS = [
    ['tab-project', 'panel-project'],
    ['tab-library', 'panel-library'],
    ['tab-midi', 'panel-midi'],
  ];

  let libraryShown = false;

  function showTab(id) {
    for (const [tab, panel] of TABS) {
      const on = tab === id;
      $(tab).setAttribute('aria-selected', String(on));
      $(tab).tabIndex = on ? 0 : -1;
      $(panel).hidden = !on;
    }
    if (id === 'tab-library' && !libraryShown) {
      libraryShown = true;
      fillLibrary($('shelf'));
    }
  }

  for (const [tab] of TABS) {
    $(tab).addEventListener('click', () => showTab(tab));
    // A tab strip is one stop in the tab order, arrows between the tabs.
    $(tab).addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const i = TABS.findIndex(([t]) => t === tab);
      const [next] = TABS[(i + step + TABS.length) % TABS.length];
      showTab(next);
      $(next).focus();
    });
  }

  /**
   * The palette, open or down to its colours.
   *
   * Shut is the resting state. A node type is a colour and a glyph before it is
   * a word — the same glyph that is drawn on the node itself — so the rail can
   * say all of it in 44px, and the difference goes to the canvas. Whichever way
   * it was left is what it opens as.
   */
  const RAIL_KEY = ns + 'gridi.rail';
  const PANE_KEY = ns + 'gridi.pane';

  function setRail(open, { keep = true } = {}) {
    mount.dataset.rail = open ? 'labels' : 'icons';
    $('rail-toggle').setAttribute('aria-expanded', String(open));
    $('rail-toggle').title = open ? 'Hide the node names' : 'Show the node names';
    if (keep) remember(RAIL_KEY, open ? 'labels' : 'icons');
  }

  /** The inspector, folded against the edge it lives on, or out again. */
  function setPane(open, { keep = true } = {}) {
    mount.dataset.pane = open ? 'open' : 'min';
    $('pane-toggle').setAttribute('aria-expanded', String(open));
    $('pane-toggle').title = open ? 'Minimise the inspector' : 'Open the inspector';
    if (keep) remember(PANE_KEY, open ? 'open' : 'min');
  }

  $('rail-toggle').addEventListener('click', () => setRail(mount.dataset.rail !== 'labels'));
  $('pane-toggle').addEventListener('click', () => setPane(mount.dataset.pane === 'min'));

  $('theme').addEventListener('click', () => {
    const next = themeHost.dataset.theme === 'dark' ? 'light' : 'dark';
    themeHost.dataset.theme = next;
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
    mount.querySelector('.head').after(warn);
  }

  let lastChrome = 0;
  function frame(now) {
    renderer.frame();

    if (now - lastChrome > 90) {
      lastChrome = now;
      const pos = engine.position();
      $('position').textContent = `${String(pos.bar).padStart(3, '0')}.${pos.beat}`;
      if (state.patch.sync === 'external' && activeEl() !== $('bpm')) {
        $('bpm').value = String(Math.round(engine.bpm));
      }
      $('log').textContent = state.log.length ? state.log.join('   ·   ') : '—';
      $('counts').textContent = counts(state.patch);
      if (state.selection.kind !== 'none') inspector.show(state.patch, state.selection);
    }
    raf = requestAnimationFrame(frame);
  }

  function boot() {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'dark') {
        themeHost.dataset.theme = 'dark';
        $('theme').textContent = 'light';
      }
    } catch {
      /* ignore */
    }
    renderer.readColors();

    // Before the first measurement of the canvas, because both of these change
    // how much of the width it gets.
    setRail(recall(RAIL_KEY) === 'labels', { keep: false });
    setPane(recall(PANE_KEY) !== 'min', { keep: false });
    showTab('tab-project');

    // Whatever was kept in this browser, and the row that says so when nothing
    // has been. Drawn now rather than when the tab is first opened, so that
    // keeping a patch has somewhere to appear from the first press.
    shelf = readShelf(recall(SHELF_KEY));
    fillMine($('mine'));

    populateKeySelects();
    // The font from last time, if there was one. Nothing waits on it: a patch is
    // playable before it arrives, and louder afterwards.
    startingFont();
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
    if (initial && initial.nodes.length) loadPatch(initial);
    else openingPatch();
    inspector.show(state.patch, state.selection);
    audio.setVolume(Number($('volume').value));

    const resize = () => {
      renderer.resize();
      if (!viewIsTheirs) fitView();
    };
    ro = new ResizeObserver(resize);
    ro.observe(canvas);
    onOutside(window, 'resize', resize);
    renderer.resize();
    fitView();

    setStatus(READY_HINT, 'Ready.');
    raf = requestAnimationFrame(frame);
  }

  boot();

  /**
   * Put everything back.
   *
   * A reader who navigates away from the note should not leave a sequencer
   * running behind them: the frame loop, the tick interval, the audio graph
   * and any MIDI ports all have to go, and the listeners on window and
   * document with them. The mount is emptied last.
   */
  function teardown() {
    if (raf !== null) cancelAnimationFrame(raf);
    if (ticker !== null) clearInterval(ticker);
    ro?.disconnect();
    for (const [target, type, fn, opts] of outside) target.removeEventListener(type, fn, opts);

    try {
      engine.stop();
      // Notes off before the ports go, or gear outside the browser holds the
      // last chord it was sent for as long as it is powered.
      midi.allOff();
      midiIn.close();
      audio.allOff();
      // Created lazily on the first sound, so there may be nothing to close.
      audio.ctx?.close();
    } catch {
      /* a copy being torn down is past caring */
    }

    mount.innerHTML = '';
    mount = null;
    themeHost = null;
  }

  live = { state, audio, midi, midiIn, engine, renderer, teardown };
  return live;
}

/** Stop the running copy and give the page back. */
export function destroyGridi() {
  if (!live) return;
  live.teardown();
  live = null;
}

/** The running copy, for a browser check or a console. */
export function getGridi() {
  return live;
}

/*
 * Its own page still starts itself. An embed sets the flag before importing
 * this module and calls initGridi when it has a container and has decided what
 * the copy should be called and where it should keep its patch.
 */
if (!window.__gridiEmbedded) {
  const el = document.getElementById('app');
  if (el) initGridi(el);
}
