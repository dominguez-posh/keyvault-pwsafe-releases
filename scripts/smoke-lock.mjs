// One smoke run at a time on this PC (#529). Windows has one clipboard and one focus for everything: a second run (or
// a test run that waits for this lock) beside it makes areas time out that pass alone (#526). The lock was only an
// agreement until now; the run sets %TEMP%\keevault-smoke.lock itself and stops when another live process holds it.
// A lock left behind by a process that no longer runs is taken over.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SMOKE_LOCK = path.join(os.tmpdir(), 'keevault-smoke.lock');

/** Is a process with this id running? */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Takes the lock → { ok: true, release() } or { ok: false, holder } (holder: { pid, started, what } of the live process).
 * fs and alive are stand-ins for the unit test.
 */
export function takeSmokeLock({ file = SMOKE_LOCK, what = 'npm run smoke', pid = process.pid, now = () => new Date(), alive = processAlive, fs = { openSync, writeSync, closeSync, readFileSync, unlinkSync } } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid, started: now().toISOString(), what })); } finally { fs.closeSync(fd); }
      return {
        ok: true,
        release: () => {
          // Only our own lock goes: a run that took over a stale one after us keeps its file.
          try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.unlinkSync(file); } catch { /* already gone */ }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: a run that is writing it, or garbage */ }
    if (holder && alive(holder.pid)) return { ok: false, holder };
    // Left behind (process gone) or unreadable: taken over once.
    try { fs.unlinkSync(file); } catch { /* someone else took it over just now */ }
  }
  return { ok: false, holder: null };
}

/** Message for a held lock. */
export const lockHeldMessage = (holder) => `SMOKE ABGEBROCHEN: ein anderer Lauf hält ${SMOKE_LOCK}${holder ? ` (PID ${holder.pid}, ${holder.what || '?'}, seit ${holder.started || '?'})` : ''}. Erst diesen Lauf beenden lassen (#529).`;
