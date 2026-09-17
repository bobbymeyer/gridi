// Grid maths, orthogonal line routing and hit testing.
//
// Lines are routed at right angles along the grid rather than as curves. The
// grid is the instrument's organising idea, so the patch cabling obeys it too.

import { clamp } from './util.js';

export const CELL = 20; // world pixels per grid cell
export const NODE_W = 6; // cells
export const NODE_H = 3; // cells
export const MODULE = 8; // cells between heavy grid rules

export const nodeWidth = () => NODE_W * CELL;
export const nodeHeight = () => NODE_H * CELL;

export function nodeRect(node) {
  return {
    x: node.col * CELL,
    y: node.row * CELL,
    w: nodeWidth(),
    h: nodeHeight(),
  };
}

export function portIn(node) {
  const r = nodeRect(node);
  return { x: r.x, y: r.y + r.h / 2 };
}

export function portOut(node) {
  const r = nodeRect(node);
  return { x: r.x + r.w, y: r.y + r.h / 2 };
}

export const nodeCenter = (node) => {
  const r = nodeRect(node);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
};

/* ------------------------------------------------------------------ camera */

export const worldToScreen = (p, view) => ({
  x: (p.x + view.x) * view.zoom,
  y: (p.y + view.y) * view.zoom,
});

export const screenToWorld = (p, view) => ({
  x: p.x / view.zoom - view.x,
  y: p.y / view.zoom - view.y,
});

export const snapCell = (worldValue) => Math.round(worldValue / CELL);

/* ----------------------------------------------------------------- routing */

const snapTo = (v) => Math.round(v / CELL) * CELL;

/**
 * Right-angled path from one node's output to another's input.
 * Forward runs take a single dog-leg; backward runs break out, travel in a
 * clear lane above or below both nodes, and come back in.
 */
export function routeLine(fromNode, toNode) {
  const a = portOut(fromNode);
  const b = portIn(toNode);
  const stub = CELL * 1.5;

  if (Math.abs(a.y - b.y) < 0.5 && b.x > a.x) return [a, b];

  if (b.x > a.x + stub * 2) {
    const midX = snapTo((a.x + b.x) / 2);
    return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
  }

  // Backwards: pick the side with less to get in the way.
  const fromR = nodeRect(fromNode);
  const toR = nodeRect(toNode);
  const above = Math.min(fromR.y, toR.y) - CELL * 2;
  const below = Math.max(fromR.y + fromR.h, toR.y + toR.h) + CELL * 2;
  const laneY = snapTo(a.y <= b.y ? above : below);
  const outX = snapTo(a.x + stub);
  const inX = snapTo(b.x - stub);
  return [
    a,
    { x: outX, y: a.y },
    { x: outX, y: laneY },
    { x: inX, y: laneY },
    { x: inX, y: b.y },
    b,
  ];
}

export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

/** Position at normalised distance `t` along a polyline. */
export function pointAlongPath(points, t) {
  const total = pathLength(points);
  if (total === 0) return { ...points[0], dx: 1, dy: 0 };
  let target = clamp(t, 0, 1) * total;
  for (let i = 1; i < points.length; i += 1) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const seg = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (seg === 0) continue;
    if (target <= seg) {
      const f = target / seg;
      return {
        x: p0.x + (p1.x - p0.x) * f,
        y: p0.y + (p1.y - p0.y) * f,
        dx: (p1.x - p0.x) / seg,
        dy: (p1.y - p0.y) / seg,
      };
    }
    target -= seg;
  }
  const last = points[points.length - 1];
  return { ...last, dx: 1, dy: 0 };
}

/** Midpoint of a polyline, where a line's channel badge is drawn. */
export function pathMidpoint(points) {
  return pointAlongPath(points, 0.5);
}

/* ------------------------------------------------------------- hit testing */

export const pointInRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

export function distanceToSegment(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

export function distanceToPath(p, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    best = Math.min(best, distanceToSegment(p, points[i - 1], points[i]));
  }
  return best;
}

/** Topmost node under a world point. Later nodes draw on top, so search back. */
export function hitNode(patch, world) {
  for (let i = patch.nodes.length - 1; i >= 0; i -= 1) {
    if (pointInRect(world, nodeRect(patch.nodes[i]))) return patch.nodes[i];
  }
  return null;
}

/**
 * Is the point on a node's output handle? Patching is the most-used gesture in
 * the app, so the target is the whole right edge rather than a dot: miss a dot
 * and you silently drag the node instead, which is a rotten way to find out.
 */
export function hitOutPort(patch, world, reach = 10) {
  for (let i = patch.nodes.length - 1; i >= 0; i -= 1) {
    const node = patch.nodes[i];
    const r = nodeRect(node);
    const inBand = world.x >= r.x + r.w - reach && world.x <= r.x + r.w + reach;
    const inSpan = world.y >= r.y - 2 && world.y <= r.y + r.h + 2;
    if (inBand && inSpan) return node;
  }
  return null;
}

export function hitLine(patch, world, nodeIndex, tolerance = 7) {
  let best = null;
  let bestDist = tolerance;
  for (const line of patch.lines) {
    const from = nodeIndex.get(line.from);
    const to = nodeIndex.get(line.to);
    if (!from || !to) continue;
    const d = distanceToPath(world, routeLine(from, to));
    if (d < bestDist) {
      bestDist = d;
      best = line;
    }
  }
  return best;
}

/** Does a candidate position overlap an existing node? Keeps placement tidy. */
export function overlapsAny(patch, col, row, ignoreId = null) {
  const r = { x: col * CELL, y: row * CELL, w: nodeWidth(), h: nodeHeight() };
  return patch.nodes.some((n) => {
    if (n.id === ignoreId) return false;
    const o = nodeRect(n);
    return r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y;
  });
}

/** Nearest free cell to (col,row), searching outward in a square spiral. */
export function findFreeCell(patch, col, row, ignoreId = null) {
  if (!overlapsAny(patch, col, row, ignoreId)) return { col, row };
  for (let ring = 1; ring < 24; ring += 1) {
    for (let dy = -ring; dy <= ring; dy += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const c = col + dx * (NODE_W + 1);
        const r = row + dy * (NODE_H + 1);
        if (!overlapsAny(patch, c, r, ignoreId)) return { col: c, row: r };
      }
    }
  }
  return { col, row };
}
