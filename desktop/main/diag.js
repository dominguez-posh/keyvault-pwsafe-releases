// Diagnosis log and timing of slow or hanging network requests (Key Vault, tokens).

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { secureFetch } from '../secure-net.js';
import { auth } from './state.js';
import { maskLogText } from '../../extension/core/log-mask.js';

// ---- Diagnostics: slow or failing requests (> 1 s, status >= 400) and slow token requests go to
// %APPDATA%\KeyVault PwSafe\diagnostics.log – method, host, path, status, duration; never headers, bodies or values.
const SLOW_MS = 1000;
let diagWrites = Promise.resolve();
export function diag(raw) {
  // #484: subscription IDs, GUIDs and UPNs never reach the file (ARM and Graph paths, Azure error texts).
  const line = maskLogText(raw);
  const file = path.join(app.getPath('userData'), 'diagnostics.log');
  diagWrites = diagWrites.then(async () => {
    try {
      if ((await fs.stat(file).catch(() => null))?.size > 512_000) await fs.rename(file, `${file}.1`);
      await fs.appendFile(file, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Diagnostics never break a request.
    }
  });
}
// A request without an answer would keep a vault "loading" forever: after REQUEST_TIMEOUT_MS it is aborted (the
// Key Vault client retries network errors twice); after PENDING_MS a still open request is logged as PENDING.
const REQUEST_TIMEOUT_MS = 30_000;
export const busySince = new Map(); // containerId → start of loading (diagnostics)
const PENDING_MS = 10_000;
export async function timedFetch(url, init = {}) {
  const started = Date.now();
  let status = 'ERR';
  let where = String(url);
  try { const u = new URL(url); where = u.host + u.pathname; } catch { /* keep */ }
  const controller = init.signal ? null : new AbortController();
  const timeout = controller && setTimeout(() => controller.abort(new Error(`Zeitüberschreitung nach ${REQUEST_TIMEOUT_MS / 1000} s`)), REQUEST_TIMEOUT_MS);
  const pending = setTimeout(() => diag(`PENDING ${init.method || 'GET'} ${where} >${PENDING_MS}ms`), PENDING_MS);
  try {
    const res = await secureFetch(url, controller ? { ...init, signal: controller.signal } : init);
    status = res.status;
    return res;
  } catch (e) {
    if (controller?.signal.aborted) status = 'TIMEOUT';
    throw e;
  } finally {
    clearTimeout(timeout);
    clearTimeout(pending);
    const ms = Date.now() - started;
    if (ms > SLOW_MS || status === 'ERR' || status === 'TIMEOUT' || status >= 400) diag(`${init.method || 'GET'} ${where} ${status} ${ms}ms`);
  }
}
export async function timedToken(scope, opts) {
  const started = Date.now();
  const pending = setTimeout(() => diag(`PENDING TOKEN ${String(scope).replace(/^https:\/\//, '')} tenant=${opts?.tenantId || 'home'} >${PENDING_MS}ms`), PENDING_MS);
  try {
    return await auth.getToken(scope, opts);
  } finally {
    clearTimeout(pending);
    const ms = Date.now() - started;
    if (ms > SLOW_MS) diag(`TOKEN ${String(scope).replace(/^https:\/\//, '')} tenant=${opts?.tenantId || 'home'} force=${!!opts?.forceRefresh} ${ms}ms`);
  }
}
