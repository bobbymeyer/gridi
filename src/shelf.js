/**
 * The patches somebody keeps.
 *
 * Gridi ships five, and remembers exactly one thing you are working on. Between
 * those two is everything you have made and want back: a sketch from Tuesday, a
 * copy of Bossa Nova with the clave moved. The shelf is that middle, kept in
 * this browser and nowhere else — it is not a sync service and does not pretend
 * to be. Saving a file is still how a patch leaves the machine.
 *
 * The name is the key, the way `save` names a file after the patch. Keeping a
 * patch under a name that is already on the shelf replaces it, which is what
 * anybody means by saving twice; keeping it under a new one is a new entry.
 *
 * Everything here is a pure function over a list, so the storage and the DOM
 * are somebody else's problem and this can be tested without either.
 */

/** What one entry is: a name, the serialized patch, and when it was kept. */
const VERSION = 1;

/** Trimmed, and never empty: an entry with no name cannot be found again. */
const clean = (name) => String(name ?? '').trim().slice(0, 60) || 'Untitled';

/**
 * Read a shelf out of storage.
 *
 * Anything unreadable is an empty shelf rather than an exception: a browser
 * that has been through three versions of this app should still open.
 */
export function readShelf(raw) {
  if (!raw) return [];
  let held;
  try {
    held = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(held) ? held : held?.patches;
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => entry && typeof entry.patch === 'string' && entry.patch.length)
    .map((entry) => ({
      name: clean(entry.name),
      patch: entry.patch,
      saved: Number(entry.saved) || 0,
    }));
}

export function writeShelf(list) {
  return JSON.stringify({ v: VERSION, patches: list });
}

/** Where a name sits on the shelf, or -1. Case is ignored: two patches called
 *  "bossa" and "Bossa" are one patch somebody has renamed. */
export function indexOfName(list, name) {
  const wanted = clean(name).toLowerCase();
  return list.findIndex((entry) => entry.name.toLowerCase() === wanted);
}

/**
 * Keep a patch, replacing whatever was under that name.
 *
 * The kept one goes to the front, because the shelf reads newest first and the
 * thing just saved is the thing most likely to be wanted next.
 */
export function keepPatch(list, name, patch, now = Date.now()) {
  const entry = { name: clean(name), patch, saved: now };
  const rest = list.filter((_, i) => i !== indexOfName(list, name));
  return [entry, ...rest];
}

export function removePatch(list, name) {
  const at = indexOfName(list, name);
  return at === -1 ? list : list.filter((_, i) => i !== at);
}

/**
 * A name for a copy that nothing on the shelf is using.
 *
 * "Bossa Nova" becomes "Bossa Nova copy", and the one after it "Bossa Nova copy
 * 2" — the same way a file manager counts, because the number is only there to
 * keep them apart.
 */
export function copyName(name, list) {
  const base = `${clean(name)} copy`;
  if (indexOfName(list, base) === -1) return base;
  for (let n = 2; n < 1000; n += 1) {
    const tried = `${base} ${n}`;
    if (indexOfName(list, tried) === -1) return tried;
  }
  return `${base} ${Date.now()}`;
}
