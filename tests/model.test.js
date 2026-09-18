import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPatch, createNode, createLine, createChannel, addNode, connect, canConnect,
  removeNode, removeLine, serialize, deserialize, demoPatch, outgoing, incoming,
  channelSummary,
  readPatch, looksLikePatch, APP_ID,
} from '../src/model.js';
import { lineCells } from '../src/geometry.js';

test('a new line inherits rather than overriding', () => {
  const line = createLine('a', 'b');
  assert.equal(line.channelMode, 'inherit');
  assert.equal(line.scaleMode, 'inherit');
  assert.equal(line.delay, 0);
  assert.equal(channelSummary(line), 'inherit');
  line.channelMode = 'set';
  line.channels = [createChannel(1), createChannel(9)];
  assert.equal(channelSummary(line), 'ch 1,9');
});

test('connection rules', () => {
  const p = createPatch();
  const clock = addNode(p, createNode('pulse', 0, 0));
  const note = addNode(p, createNode('note', 10, 0));
  assert.ok(canConnect(p, clock.id, note.id));
  assert.ok(!canConnect(p, clock.id, clock.id), 'no self-loops');
  assert.ok(!canConnect(p, note.id, clock.id), 'a pulse emitter takes no input');
  connect(p, clock.id, note.id);
  assert.ok(!canConnect(p, clock.id, note.id), 'no duplicate lines');
  assert.equal(p.lines.length, 1);
  assert.equal(connect(p, clock.id, note.id), null);
});

test('removing a node takes its lines with it', () => {
  const p = createPatch();
  const a = addNode(p, createNode('pulse', 0, 0));
  const b = addNode(p, createNode('split', 10, 0));
  const c = addNode(p, createNode('note', 20, 0));
  connect(p, a.id, b.id);
  connect(p, b.id, c.id);
  assert.equal(outgoing(p, b.id).length, 1);
  assert.equal(incoming(p, b.id).length, 1);
  removeNode(p, b.id);
  assert.equal(p.nodes.length, 2);
  assert.equal(p.lines.length, 0);
});

test('removing a node clears param nodes aimed at it', () => {
  const p = createPatch();
  const target = addNode(p, createNode('note', 20, 0));
  const mod = addNode(p, createNode('param', 10, 0, { target: target.id, param: 'degree' }));
  removeNode(p, target.id);
  assert.equal(mod.params.target, '');
  assert.equal(mod.params.param, '');
});

test('removeLine only removes the one', () => {
  const p = createPatch();
  const a = addNode(p, createNode('pulse', 0, 0));
  const b = addNode(p, createNode('note', 10, 0));
  const c = addNode(p, createNode('note', 10, 8));
  const l1 = connect(p, a.id, b.id);
  connect(p, a.id, c.id);
  removeLine(p, l1.id);
  assert.equal(p.lines.length, 1);
});

test('a patch round trips through JSON intact', () => {
  const p = demoPatch();
  const line = p.lines[2];
  line.channelMode = 'set';
  line.channels = [createChannel(3), { out: 'B', ch: 7, transpose: -12, velocity: 44 }];
  line.scaleMode = 'set';
  line.scale = 'dorian';
  line.root = 2;
  line.delay = 0.75;

  const back = deserialize(serialize(p));
  assert.equal(back.nodes.length, p.nodes.length);
  assert.equal(back.lines.length, p.lines.length);
  assert.equal(back.bpm, p.bpm);
  assert.equal(back.root, p.root);
  const restored = back.lines[2];
  assert.equal(restored.channelMode, 'set');
  assert.deepEqual(restored.channels, [
    { out: 'A', ch: 3, transpose: 0, velocity: null },
    { out: 'B', ch: 7, transpose: -12, velocity: 44 },
  ]);
  assert.equal(restored.scale, 'dorian');
  assert.equal(restored.delay, 0.75);
  assert.equal(back.nodes[0].params.euclidPulses, p.nodes[0].params.euclidPulses);
});

test('deserialize repairs junk instead of throwing', () => {
  const broken = {
    bpm: 9999,
    root: 44,
    scale: 'not-a-scale',
    nodes: [
      { type: 'note', col: 1, row: 1, id: 'keep' },
      { type: 'nonsense', col: 2, row: 2, id: 'drop' },
      null,
    ],
    lines: [
      { from: 'keep', to: 'missing' },
      { from: 'keep', to: 'keep' },
      { from: 'keep', to: 'drop' },
    ],
  };
  const p = deserialize(JSON.stringify(broken));
  assert.equal(p.nodes.length, 1);
  assert.equal(p.nodes[0].id, 'keep');
  assert.equal(p.lines.length, 0, 'lines to dropped or missing nodes go too');
  assert.ok(p.bpm <= 300);
  assert.ok(p.root <= 11);
  assert.equal(p.scale, 'minPent');
});

test('missing params fall back to type defaults', () => {
  const p = deserialize(JSON.stringify({ nodes: [{ type: 'pulse', col: 0, row: 0, params: { swing: 0.3 } }] }));
  assert.equal(p.nodes[0].params.swing, 0.3);
  assert.equal(p.nodes[0].params.division, '1/16');
  assert.equal(p.nodes[0].params.running, true);
});

test('an unknown division is replaced', () => {
  const p = deserialize(JSON.stringify({ nodes: [{ type: 'pulse', col: 0, row: 0, params: { division: '1/7' } }] }));
  assert.equal(p.nodes[0].params.division, '1/16');
});

test('the demo patch is a working instrument', () => {
  const p = demoPatch();
  const emitters = p.nodes.filter((n) => n.type === 'pulse');
  assert.ok(emitters.length >= 1);
  for (const node of p.nodes) {
    if (node.type === 'pulse') continue;
    assert.ok(incoming(p, node.id).length > 0, `${node.type} should be fed by something`);
  }
  assert.ok(p.lines.some((l) => l.channelMode === 'set'), 'demonstrates channels on a line');
  // The demo used to lean on a line delay to flam its router branches. It
  // gets that from the drawing now, so what it has to show is lines of
  // different lengths feeding the same place.
  const byNode = new Map(p.nodes.map((n) => [n.id, n]));
  const lengths = p.lines.map((l) => lineCells(byNode.get(l.from), byNode.get(l.to)));
  assert.ok(new Set(lengths).size > 1, 'demonstrates distance as timing');
  assert.ok(p.nodes.some((n) => n.type === 'key' && n.params.latch), 'demonstrates live key change');
});

/* ------------------------------------------------------- the patch grid */

test('a new patch measures its cells in sixteenth notes', () => {
  assert.equal(createPatch('x').grid, '1/16');
});

test('the grid survives a save and an open', () => {
  const p = createPatch('grid');
  p.grid = '1/16';
  assert.equal(deserialize(serialize(p)).grid, '1/16');
});

test('a patch from before the grid existed opens on the default', () => {
  const older = { name: 'old', bpm: 120, nodes: [], lines: [] };
  assert.equal(deserialize(JSON.stringify(older)).grid, '1/16');
});

test('a grid value that is not on offer is refused, not trusted', () => {
  const bogus = { name: 'b', grid: '1/5', nodes: [], lines: [] };
  assert.equal(deserialize(JSON.stringify(bogus)).grid, '1/16');
});

/* ------------------------------------------------- patches as shared files */

test('every saved patch is stamped, so a drop can be told apart from any JSON', () => {
  const raw = JSON.parse(serialize(createPatch('stamped')));
  assert.equal(raw.app, APP_ID);
  assert.equal(raw.name, 'stamped');
});

test('a saved patch reads back as the same patch', () => {
  const p = demoPatch();
  const back = readPatch(serialize(p));
  assert.equal(back.nodes.length, p.nodes.length);
  assert.equal(back.lines.length, p.lines.length);
  assert.equal(back.name, p.name);
  assert.equal(back.grid, p.grid);
});

test('anything that is not a patch is declined rather than opened', () => {
  for (const text of [
    '',
    'hello',
    '<svg></svg>',
    '[]',
    '{}',
    '{"nodes":[],"lines":[]}',
    '{"nodes":[{"type":"not a node type"}],"lines":[]}',
    '{"app":"something-else","nodes":[{"type":"pulse"}]}',
  ]) {
    assert.equal(readPatch(text), null, `${text} should not open`);
  }
});

test('a patch saved before the stamp existed is recognised by its shape', () => {
  const raw = JSON.parse(serialize(demoPatch()));
  delete raw.app;
  const back = readPatch(JSON.stringify(raw));
  assert.ok(back, 'an older file still opens');
  assert.equal(back.nodes.length, raw.nodes.length);
});

test('a stamped file is trusted even when it holds nothing yet', () => {
  assert.ok(looksLikePatch({ app: APP_ID, nodes: [], lines: [] }), 'an empty patch is a patch');
  assert.ok(readPatch(serialize(createPatch('empty'))), 'and opens');
});

test('a patch too big to hold is truncated on the way in, not refused', () => {
  const p = createPatch('huge');
  for (let i = 0; i < 20; i += 1) addNode(p, createNode('note', i * 10, 0));
  const limits = [];
  const back = readPatch(serialize(p), (kind, asked, kept) => limits.push({ kind, asked, kept }));
  assert.equal(back.nodes.length, 20, 'well inside the ceiling');
  assert.deepEqual(limits, []);
});
