// Keeping a SoundFont between visits.
//
// A General MIDI font is a hundred megabytes and more, which is too much for
// local storage and nothing at all for IndexedDB. One record, one key: drop a
// font once and it is there the next time the page opens.

const DB = 'gridi';
const STORE = 'files';
const KEY = 'soundfont';

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no IndexedDB'));
      return;
    }
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused'));
  });
}

function run(db, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = work(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted'));
  });
}

/**
 * Put a font away. Quota is the one failure worth expecting, and it is not
 * fatal: the font is loaded either way, it just will not be there next time.
 *
 * @returns {Promise<boolean>} whether it was kept
 */
export async function keepSoundfont(bytes, name) {
  try {
    const db = await open();
    await run(db, 'readwrite', (store) => store.put({ bytes, name, at: Date.now() }, KEY));
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** The font from last time, or null. */
export async function recallSoundfont() {
  try {
    const db = await open();
    const held = await run(db, 'readonly', (store) => store.get(KEY));
    db.close();
    return held?.bytes ? held : null;
  } catch {
    return null;
  }
}

/** Throw the kept font away. */
export async function forgetSoundfont() {
  try {
    const db = await open();
    await run(db, 'readwrite', (store) => store.delete(KEY));
    db.close();
    return true;
  } catch {
    return false;
  }
}
