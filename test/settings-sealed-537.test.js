import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildSettingsFile, SETTINGS_FILE_KEYS } from '../desktop/settings-file.js';
import { DEVICE_ONLY, openSealedFile, peekSealedFile, SealedSettingsError, sealSettingsFile, settingsKey } from '../desktop/settings-sealed.js';

// #537 stage 5 (E5): the OneDrive copy of the settings, AES-GCM with a key from the personal vault, head as AAD.

const ck = crypto.randomBytes(32);
const key = { ckRaw: ck, vaultId: 'f-personal-1', kv: 3 };
const settings = {
  theme: 'dark', autoLockMinutes: 5, containers: [{ name: 'Team', vaultUrl: 'https://kv-team.vault.azure.net/' }],
  // never in the copy
  unlockKeys: { blob: 'x' }, appPin: { hash: 'h' }, pinGuard: { fails: 2 }, personalDeviceKeys: { a: 'b' }, breakGlass: { t: [] },
};
const sealed = () => sealSettingsFile(settings, { ...key, device: 'Altes-Notebook', now: new Date('2026-11-13T10:00:00Z') });
const code = (fn) => { try { fn(); return null; } catch (e) { assert.ok(e instanceof SealedSettingsError, e.message); return e.code; } };

test('round trip: the allowlisted settings, nothing device-bound, nothing readable but the head', () => {
  const text = sealed();
  for (const s of ['"theme"', 'dark', 'kv-team', '"appPin"', '"unlockKeys"', '"pinGuard"', '"personalDeviceKeys"', '"breakGlass"', '"hash"']) assert.ok(!text.includes(s), s);
  const head = peekSealedFile(text);
  assert.equal(head.device, 'Altes-Notebook');
  assert.equal(head.vault, 'f-personal-1');
  assert.equal(head.kv, 3);
  const r = openSealedFile(text, key);
  assert.deepEqual(r.settings, { containers: [{ name: 'Team', vaultUrl: 'https://kv-team.vault.azure.net/' }], autoLockMinutes: 5, theme: 'dark' });
  assert.deepEqual(r.dropped, []);
});

test('device-bound fields are not in the allowlist (Konrad E5)', () => {
  for (const k of DEVICE_ONLY) assert.ok(!Object.hasOwn(SETTINGS_FILE_KEYS, k), k);
  for (const k of ['unlockKeys', 'appPin', 'pinGuard', 'personalDeviceKeys']) assert.ok(DEVICE_ONLY.includes(k), k);
});

test('a changed head (device, date, vault, generation) is refused', () => {
  const data = JSON.parse(sealed());
  const head = JSON.parse(data.head);
  const withHead = (h) => JSON.stringify({ ...data, head: JSON.stringify({ ...head, ...h }) });
  assert.equal(code(() => openSealedFile(withHead({ device: 'Fremd-PC' }), key)), 'tampered');
  assert.equal(code(() => openSealedFile(withHead({ exportedAt: '2027-01-01T00:00:00.000Z' }), key)), 'tampered');
  assert.equal(code(() => openSealedFile(withHead({ vault: 'f-other' }), key)), 'vault');
  assert.equal(code(() => openSealedFile(withHead({ kv: 2 }), key)), 'older');
  assert.equal(code(() => openSealedFile(withHead({ kv: 4 }), key)), 'newer');
  // the same head string, other key order: not the AAD any more
  const reordered = JSON.stringify({ ...data, head: JSON.stringify({ kv: head.kv, vault: head.vault, exportedAt: head.exportedAt, device: head.device }) });
  assert.equal(code(() => openSealedFile(reordered, key)), 'tampered');
});

test('a changed ciphertext, another key, another generation key: refused', () => {
  const data = JSON.parse(sealed());
  const ct = Buffer.from(data.ct, 'base64');
  ct[20] ^= 1;
  assert.equal(code(() => openSealedFile(JSON.stringify({ ...data, ct: ct.toString('base64') }), key)), 'tampered');
  assert.equal(code(() => openSealedFile(sealed(), { ...key, ckRaw: crypto.randomBytes(32) })), 'tampered');
  assert.notDeepEqual(settingsKey(ck, 'f-personal-1', 3), settingsKey(ck, 'f-personal-1', 4));
  assert.notDeepEqual(settingsKey(ck, 'f-personal-1', 3), settingsKey(ck, 'f-personal-2', 3));
  // after a key change the copy is under the new generation: the old one no longer fits
  const next = { ...key, ckRaw: crypto.randomBytes(32), kv: 4 };
  assert.equal(code(() => openSealedFile(sealed(), next)), 'older');
  assert.equal(openSealedFile(sealSettingsFile(settings, { ...next, device: 'x' }), next).settings.theme, 'dark');
});

test('foreign fields: at the top, in the head and inside are refused or dropped', () => {
  const data = JSON.parse(sealed());
  assert.equal(code(() => openSealedFile(JSON.stringify({ ...data, settings: { theme: 'light' } }), key)), 'format');
  assert.equal(code(() => openSealedFile(JSON.stringify({ ...data, head: JSON.stringify({ ...JSON.parse(data.head), evil: 1 }) }), key)), 'format');
  // A copy made with the right key but with keys outside the allowlist inside (another app version, a crafted copy):
  // the strict reading of the plain file applies.
  const inner = Buffer.from(JSON.stringify({ settings: { theme: 'light', appPin: { hash: 'x' }, adminTools: true, unlockKeys: { blob: 'y' }, autoLockMinutes: -1 } }));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', settingsKey(ck, key.vaultId, key.kv), iv);
  c.setAAD(Buffer.from(`kvpwsafe-settings|2|${data.head}`));
  const ct = Buffer.concat([iv, c.update(inner), c.final(), c.getAuthTag()]).toString('base64');
  const r = openSealedFile(JSON.stringify({ ...data, ct }), key);
  assert.deepEqual(r.settings, { theme: 'light' });
  assert.deepEqual(r.dropped.sort(), ['adminTools', 'appPin', 'autoLockMinutes', 'unlockKeys']);
});

test('the plain copy of before is recognised and not read as a copy', () => {
  const plain = buildSettingsFile({ theme: 'dark' }, { device: 'x' });
  assert.equal(code(() => peekSealedFile(plain)), 'plain');
  assert.equal(code(() => openSealedFile(plain, key)), 'plain');
  assert.equal(code(() => peekSealedFile('{"marker":"kvpwsafe-settings","version":3}')), 'format');
  assert.equal(code(() => peekSealedFile('nonsense')), 'format');
  assert.equal(code(() => peekSealedFile('x'.repeat(300 * 1024))), 'format');
});

test('settings-copy.js: no plain copy any more, the old one goes once, the new device counts the master password', () => {
  const src = fs.readFileSync(new URL('../desktop/main/settings-copy.js', import.meta.url), 'utf8');
  const write = src.slice(src.indexOf('export async function writeSettingsCopy'), src.indexOf('// ---------------------------------------------------------------- import'));
  assert.doesNotMatch(write, /buildSettingsFile/, 'the OneDrive copy is never the plain file');
  assert.match(write, /sealSettingsFile/);
  assert.match(write, /if \(!key\) \{\n\s+if \(plainBefore\)/, 'no personal vault: nothing written, the plain copy removed');
  assert.match(write, /plainCopyGone/);
  assert.match(src, /if \(s\.settingsCopy !== true \|\| s\.settingsCopyPending\) return null;/);
  const adopt = src.slice(src.indexOf('export async function adoptOneDriveSetup'));
  assert.ok(adopt.indexOf('await migrate(') < adopt.indexOf('openSealedFile('), 'the master password first (counted in migrate), then the copy');
  assert.match(adopt, /else files\.remove\(id\);\n\s+throw e;/, 'a wrong master password lists nothing');
  const status = src.slice(src.indexOf('export async function settingsCopyStatus'), src.indexOf('// ---------------------------------------------------------------- new device'));
  assert.match(status, /isPlainCopy\(raw\)\) return \{ oneDrive: true, found: false, plain: true \}/, 'the plain copy is not offered at the first start');
});

test('Konrad (review of 8f5521b): plain imports marked, the notice once per device', () => {
  const src = fs.readFileSync(new URL('../desktop/main/settings-copy.js', import.meta.url), 'utf8');
  assert.match(src, /return \{ \.\.\.parseSettingsFile\(raw\), plain: true \}/);
  assert.match(src, /const first = !config\.get\(\)\.settingsCopyPlainGone;[\s\S]{0,120}if \(first\) send\(\{ type: 'settingsCopyPlainGone' \}\)/);
  const win = fs.readFileSync(new URL('../desktop/renderer/app/settings-file.js', import.meta.url), 'utf8');
  assert.match(win, /preview\.plain \? h\('p', \{ class: 'notice warn small settings-plain-origin' \}/);
  assert.doesNotMatch(win, /kannst du sie bewusst wählen/);
});
