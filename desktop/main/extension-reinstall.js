// #494: "Browser-Erweiterung neu installieren" – one click repairs the extension. The click is the consent: UAC follows at
// once (desktop/machine-setup.js, only reg.exe with fixed values), our policy entries are removed and written anew with
// the feed of the update channel, the native messaging host is registered again. The window then asks whether to restart
// Edge (and Chrome) completely (desktop/browser-restart.js) and this module waits for the extension to connect again.
// A company policy is never touched (rule in machine-setup.js, Lucas 08.11.: "gezielt lockern").

import { app } from 'electron';
import { canReinstall, runReinstallSetup, windowsFolder } from '../machine-setup.js';
import { BROWSER_IMAGES, browserLaunch, restartBrowser } from '../browser-restart.js';
import { applyBrowserIntegration, currentExtensionStatus, extensionClients } from './browser.js';
import { config } from './state.js';
import { currentChannel, extensionPolicies, policySimulated } from './extension-channel.js';
import { forgetSharedReads } from '../shared-read.js';

/**
 * Smoke only: { policies: { edge, chrome } of browserPolicy(), installed: { edge, chrome }, reinstall({ channel, browsers })
 * → { result, browsers }, restart(browser) → { ok, reason }, waitMs } instead of the registry, UAC and the browsers.
 */
let simulated = null;
export function simulateExtensionReinstall(sim) { simulated = sim; }
export { simulateExtensionPolicy } from './extension-channel.js'; // both stand-ins for the smoke run in one import

const CONNECT_WAIT_MS = 60_000;
/** Browsers the last successful "Neu installieren" set up: only they may be restarted, once (the window cannot end a browser on its own). */
let restartAllowed = new Set();
// A smoke run that only simulates the policies (#455 check) must not read the device either: Edge counts as installed there.
const supported = () => !!simulated || policySimulated() || (process.platform === 'win32' && !!windowsFolder());
// An untrusted start path still counts as installed: set up anew, only the restart is left to the user (#494).
const installed = async (browser) => (simulated ? !!simulated.installed?.[browser] : policySimulated() ? browser === 'edge' : (await browserLaunch(browser)).reason !== 'missing');

/** The browsers "Neu installieren" covers: Edge always (part of Windows), Chrome when installed or set up by us before. */
async function covered(p) {
  const chrome = (await installed('chrome')) || p.chrome.state === 'ours';
  return chrome ? Object.keys(BROWSER_IMAGES) : ['edge'];
}

/** What the settings and the hint may offer: { available, company, browsers }. company: some browser is the IT's. */
export async function extensionReinstallState() {
  if (!supported()) return { available: false, company: false, browsers: [] };
  const p = simulated ? simulated.policies : await extensionPolicies();
  const browsers = await covered(p);
  return { available: browsers.some((b) => canReinstall(p[b])), company: browsers.some((b) => !canReinstall(p[b])), browsers };
}

/**
 * The elevated step and the native messaging host. Resolves { result, browsers, nativeHost }: result one of unavailable,
 * company, declined, failed, changed; browsers: the installed browsers that were set up anew (to ask for a restart);
 * nativeHost: 'ok', 'off' (the browser access is switched off in the settings) or 'failed'.
 */
export async function reinstallExtension() {
  restartAllowed = new Set();
  // Only the policies simulated (smoke): never the real UAC step.
  if (!supported() || (policySimulated() && !simulated)) return { result: 'unavailable', browsers: [] };
  const state = await extensionReinstallState();
  if (!state.available) return { result: 'company', browsers: [] };
  const channel = currentChannel();
  const options = { channel, browsers: state.browsers };
  const r = simulated ? await simulated.reinstall(options) : await runReinstallSetup(undefined, undefined, options).finally(forgetSharedReads);
  if (r.result !== 'changed') return { result: r.result, browsers: [] };
  let nativeHost = 'off';
  if (config.get().browserIntegration) {
    try {
      if (!simulated) await applyBrowserIntegration();
      nativeHost = 'ok';
    } catch {
      nativeHost = 'failed';
    }
  }
  const restartable = [];
  for (const b of r.browsers || []) if (await installed(b)) restartable.push(b);
  restartAllowed = new Set(restartable);
  return { result: 'changed', browsers: restartable, nativeHost, channel };
}

const isBrowserClient = (c) => c?.approved && !String(c.origin || '').startsWith('mcp:');

/**
 * Restarts the chosen browsers completely and waits until the extension connects again (a client that was not there
 * before the restart). Resolves { restarted, failed: [{ browser, reason }], connected, state, extVersion, expected }.
 */
export async function restartBrowsersAndCheck(browsers) {
  const list = [...new Set((Array.isArray(browsers) ? browsers : []).filter((b) => Object.hasOwn(BROWSER_IMAGES, b) && restartAllowed.has(b)))];
  restartAllowed = new Set();
  const before = new Set(extensionClients());
  const restarted = [];
  const failed = [];
  for (const b of list) {
    const r = simulated ? await simulated.restart(b) : policySimulated() ? { ok: false, reason: 'unavailable' } : await restartBrowser(b);
    if (r.ok) restarted.push(b);
    else failed.push({ browser: b, reason: r.reason || 'failed' });
  }
  const expected = app.getVersion();
  if (!restarted.length) return { restarted, failed, connected: false, expected };
  const wait = simulated?.waitMs ?? CONNECT_WAIT_MS;
  let fresh = [];
  for (let left = wait; left >= 0; left -= 500) {
    fresh = extensionClients().filter((c) => isBrowserClient(c) && !before.has(c));
    if (fresh.length) break;
    if (left) await new Promise((r) => setTimeout(r, Math.min(500, left)));
  }
  if (!fresh.length) return { restarted, failed, connected: false, expected };
  const status = currentExtensionStatus(fresh);
  return { restarted, failed, connected: true, state: status.state, extVersion: status.extVersion || '', expected };
}
