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

/**
 * A response body, with a running count of what has arrived.
 *
 * `res.arrayBuffer()` resolves once and says nothing on the way, which for a
 * thirty-two megabyte SoundFont is a minute of silence with no way to draw a
 * bar across it. Reading the stream instead costs one concatenation at the end
 * and buys a number on every chunk.
 *
 * `total` is what the response declares, and it is 0 when it declares nothing
 * -- a chunked reply, or one the server compressed -- so a caller drawing a bar
 * has to have something to show for not knowing. It can also be an undercount
 * for the same reason, since the declared length is of the encoded body: clamp
 * before dividing. A body that cannot be streamed falls back to the one-shot
 * read, so this is never worse than what it replaces.
 *
 * @param {Response} res
 * @param {(loaded: number, total: number) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
export async function readWithProgress(res, onProgress = () => {}) {
  const total = Number(res.headers?.get?.('content-length')) || 0;
  const reader = res.body?.getReader?.();
  if (!reader) {
    const whole = await res.arrayBuffer();
    onProgress(whole.byteLength, total || whole.byteLength);
    return whole;
  }

  const chunks = [];
  let loaded = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }

  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes.buffer;
}
