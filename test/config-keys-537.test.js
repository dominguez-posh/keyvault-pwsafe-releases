// #537/#539 smoke finding: Config.update stores only keys listed in DEFAULTS – a device memory missing there was dropped
// silently (appSettingsSeen, confirmEachVaults, confirmEachPersonalOnly, memberKeySeen, memberKeyDevice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync('desktop/config.js', 'utf8');
const block = src.slice(src.indexOf('const DEFAULTS'), src.indexOf('\n};', src.indexOf('const DEFAULTS')));
const defaults = new Set([...block.matchAll(/^\s+([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((n) => walk(path.join(p, n))) : [p]);

// Keys inside nested values of a config.update literal (not settings themselves).
const NESTED = new Set(['vaultId', 'vaultUrl', 'fps', 'ct', 'until', 'entry', 'vault', 'gen']);

test('every key the main process writes with config.update is listed in DEFAULTS (else it is dropped)', () => {
  const written = new Set();
  for (const f of walk('desktop').filter((x) => x.endsWith('.js') && !x.includes(`${path.sep}renderer${path.sep}`) && !path.basename(x).startsWith('smoke'))) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/config\.update\(\{([^}]*)/g)) for (const k of m[1].matchAll(/(?:^|,)\s*([A-Za-z0-9_]+)\s*[:,]/g)) written.add(k[1]);
    for (const m of s.matchAll(/\bnext\.([A-Za-z0-9_]+)\s*=/g)) if (f.endsWith(`${path.sep}access.js`)) written.add(m[1]);
  }
  const missing = [...written].filter((k) => !defaults.has(k) && !NESTED.has(k));
  assert.deepEqual(missing, []);
  for (const k of ['appSettingsSeen', 'memberKeySeen', 'memberKeyDevice', 'confirmEachVaults', 'confirmEachPersonalOnly', 'unlockKeys', 'mpResetsSeen']) assert.ok(defaults.has(k), k);
});

test('device keys: never preset by the organization file, never sent to the window – and the window uses none of them', () => {
  const list = /export const DEVICE_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(readFileSync('desktop/window-lock-settings.js', 'utf8'))[1].match(/'([A-Za-z]+)'/g).map((x) => x.slice(1, -1));
  for (const k of ['unlockKeys', 'appPin', 'personalDeviceKeys', 'memberKeySeen', 'memberKeyDevice', 'appSettingsSeen', 'confirmEachVaults', 'confirmEachPersonalOnly', 'mpResetsSeen']) assert.ok(list.includes(k), k);
  assert.ok(!list.includes('offlineMirror'), 'a switch the settings page shows stays visible');
  assert.match(src, /filter\(\(\[k\]\) => k in DEFAULTS && !DEVICE_KEYS\.includes\(k\)\)/);
  const app = readFileSync('desktop/main/api/app.js', 'utf8');
  assert.match(app, /settings: forWindow\(/);
  assert.doesNotMatch(app, /return config\.get\(\);|: config\.get\(\);/, 'every settings answer to the window goes through forWindow');
  const renderer = walk('desktop/renderer').filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
  for (const k of list) assert.doesNotMatch(renderer, new RegExp(`settings\\??\\.${k}\\b`), `the window reads ${k}`);
});
