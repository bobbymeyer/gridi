import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CELL, routeLine, pathLength, pointAlongPath, distanceToPath, hitNode, hitOutPort,
  overlapsAny, findFreeCell, portIn, portOut, screenToWorld, worldToScreen,
} from '../src/geometry.js';
import { createPatch, createNode, addNode } from '../src/model.js';

const node = (col, row) => createNode('note', col, row);

test('routes are made only of right angles', () => {
  const cases = [
    [node(0, 0), node(20, 10)],
    [node(20, 10), node(0, 0)], // backwards
    [node(0, 0), node(4, 0)], // overlapping horizontally
    [node(0, 0), node(20, 0)], // straight across
  ];
  for (const [a, b] of cases) {
    const pts = routeLine(a, b);
    for (let i = 1; i < pts.length; i += 1) {
      const dx = Math.abs(pts[i].x - pts[i - 1].x);
      const dy = Math.abs(pts[i].y - pts[i - 1].y);
      assert.ok(dx < 0.001 || dy < 0.001, 'segment must be axis aligned');
    }
    assert.deepEqual(pts[0], portOut(a));
    assert.deepEqual(pts.at(-1), portIn(b));
  }
});

test('an aligned forward route is a single straight run', () => {
  const pts = routeLine(node(0, 0), node(20, 0));
  assert.equal(pts.length, 2);
});

test('a backward route leaves a lane clear of both nodes', () => {
  const a = node(20, 10);
  const b = node(0, 10);
  const pts = routeLine(a, b);
  const lane = Math.min(...pts.map((p) => p.y));
  assert.ok(lane < 10 * CELL, 'lane should clear the nodes');
});

test('travel along a path is monotonic and ends where it should', () => {
  const pts = routeLine(node(0, 0), node(20, 10));
  const start = pointAlongPath(pts, 0);
  const end = pointAlongPath(pts, 1);
  assert.ok(Math.hypot(start.x - pts[0].x, start.y - pts[0].y) < 1e-6);
  assert.ok(Math.hypot(end.x - pts.at(-1).x, end.y - pts.at(-1).y) < 1e-6);
  let prev = -1;
  for (let t = 0; t <= 1; t += 0.05) {
    const p = pointAlongPath(pts, t);
    const travelled = distanceToPath(p, pts);
    assert.ok(travelled < 0.001, 'point stays on the path');
    const along = Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
    assert.ok(along >= prev - 1e-9 || t > 0.5);
    prev = along;
  }
  assert.ok(pathLength(pts) > 0);
});

test('camera transforms round trip', () => {
  const view = { x: -40, y: 12, zoom: 1.75 };
  const world = { x: 123, y: -45 };
  const back = screenToWorld(worldToScreen(world, view), view);
  assert.ok(Math.abs(back.x - world.x) < 1e-9);
  assert.ok(Math.abs(back.y - world.y) < 1e-9);
});

test('hit testing finds the topmost node', () => {
  const p = createPatch();
  const under = addNode(p, node(10, 10));
  const over = addNode(p, node(10, 10));
  assert.equal(hitNode(p, { x: 10 * CELL + 5, y: 10 * CELL + 5 }).id, over.id);
  assert.equal(hitNode(p, { x: -50, y: -50 }), null);
  assert.ok(under);
});

test('placement avoids overlapping nodes', () => {
  const p = createPatch();
  addNode(p, node(10, 10));
  assert.ok(overlapsAny(p, 10, 10));
  assert.ok(overlapsAny(p, 12, 11), 'partial overlap counts');
  assert.ok(!overlapsAny(p, 40, 40));
  const free = findFreeCell(p, 10, 10);
  assert.ok(!overlapsAny(p, free.col, free.row));
});

test('the output handle is the whole right edge, not a dot', () => {
  const p = createPatch();
  const n = addNode(p, node(10, 10));
  const r = { x: 10 * CELL, y: 10 * CELL, w: 6 * CELL, h: 3 * CELL };
  const right = r.x + r.w;
  // Anywhere down the right edge counts, not just the port's own centre line.
  for (const y of [r.y, r.y + r.h / 2, r.y + r.h]) {
    assert.equal(hitOutPort(p, { x: right, y })?.id, n.id, `y=${y}`);
    assert.equal(hitOutPort(p, { x: right - 6, y })?.id, n.id, `inside edge, y=${y}`);
    assert.equal(hitOutPort(p, { x: right + 6, y })?.id, n.id, `outside edge, y=${y}`);
  }
  // The left side and the body are not the handle.
  assert.equal(hitOutPort(p, { x: r.x + 4, y: r.y + 10 }), null);
  assert.equal(hitOutPort(p, { x: right + 40, y: r.y + 10 }), null);
  assert.equal(hitOutPort(p, { x: right, y: r.y - 30 }), null);
});
