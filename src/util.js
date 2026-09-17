// Small shared helpers. No DOM, no side effects.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

/** Wraps an index into [0, n) for any integer, including negatives. */
export const wrap = (i, n) => ((i % n) + n) % n;

let idCounter = 0;
/** Short, human-scannable ids: n1, n2, l1... Prefixed so logs stay readable. */
export function makeId(prefix) {
  idCounter += 1;
  return `${prefix}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}

/** Deterministic PRNG so a seeded patch replays identically. mulberry32. */
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const deepClone = (v) => JSON.parse(JSON.stringify(v));

/** Min-heap keyed by `time`, used to walk scheduled pulse events in order. */
export class EventQueue {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].time <= a[i].time) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l].time < a[s].time) s = l;
        if (r < a.length && a[r].time < a[s].time) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
  clear() {
    this.items.length = 0;
  }
}
