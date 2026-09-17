import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPatch, createNode, createLine, createChannel, addNode, connect, canConnect,
  removeNode, removeLine, serialize, deserialize, demoPatch, outgoing, incoming,
  channelSummary,
} from '../src/model.js';

test('a new line inherits rather than overriding', () => {
  const line = createLine('a', 'b');
  assert.equal(line.channelMode, 'inherit');
  assert.equal(line.scaleMode, 'inherit');
  assert.equal(line.delay, 0);
  assert.equal(channelSummary(line), 'INHERIT');
  line.channelMode = 'set';
  line.channels = [createChannel(1), createChannel(9)];
  assert.equal(channelSummary(line), 'CH 1,9');
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
  line.channels = [createChannel(3), { ch: 7, transpose: -12, velocity: 44 }];
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
    { ch: 3, transpose: 0, velocity: null },
    { ch: 7, transpose: -12, velocity: 44 },
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
  assert.ok(p.lines.some((l) => l.delay > 0), 'demonstrates line delay');
  assert.ok(p.nodes.some((n) => n.type === 'key' && n.params.latch), 'demonstrates live key change');
});
