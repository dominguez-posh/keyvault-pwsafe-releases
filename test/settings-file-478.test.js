import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSettingsFile, importPlan, linkedCopyFolder, NEVER_IN_FILE, newVaultsOf, parseSettingsFile, pickSettings, SETTINGS_FILE_KEYS, SETTINGS_MARKER, vaultUrlOf } from '../desktop/settings-file.js';

// #478: the settings file (OneDrive copy, export, import) – plain JSON, so only the allowlist and nothing secret.

const SECRET_KEYS = ['appPin', 'pinGuard', 'personalDeviceKeys', 'personalRecoveryPending', 'personalRecoveryRenewed', 'personalVaults', 'fileContainers',
  'fileIds', 'fileIdNotes', 'approvedAgents', 'agentRules', 'mcpTrusted', 'mcpScopes', 'adminTools', 'license', 'licenseKey', 'token', 'accessToken',
  'refreshToken', 'recoveryKey', 'settingsSync', 'settingsSyncedAt', 'settingsCopyPending'];

const full = () => ({
  // allowlisted
  containers: [{ name: 'Team', vaultUrl: 'https://kv-team.vault.azure.net/', tenantId: '11111111-2222-3333-4444-555555555555', extra: 'x' }],
  hiddenContainers: ['kv-old.vault.azure.net'],
  containerOrder: ['kv-team.vault.azure.net', 'f-1234'],
  defaultContainer: 'kv-team.vault.azure.net',
  tenantId: 'contoso.onmicrosoft.com',
  clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  autoLockMinutes: 30,
  clipboardSeconds: 20,
  language: 'en',
  zoom: 1.2,
  theme: 'dark',
  transparency: 'off',
  sourceBadges: false,
  autoTypeKeys: 'CommandOrControl+Alt',
  updateMode: 'auto',
  updateChannel: 'stable',
  breakGlass: { '11111111-2222-3333-4444-555555555555': [{ id: 'u1', type: 'user', displayName: 'BG 1', detail: 'bg1@contoso.com' }] },
  adminOffered: true,
  // never in the file
  appPin: { hash: 'h', salt: 's' },
  pinGuard: { failures: 2 },
  personalDeviceKeys: { 'C:\\x.kvpws': 'secret-key' },
  personalRecoveryPending: { a: 'b' },
  personalVaults: ['C:\\Users\\me\\OneDrive\\Keevault-Persoenlich.kvpws'],
  fileContainers: ['C:\\x.kvpws'],
  approvedAgents: ['claude'],
  agentRules: { claude: { write: true } },
  adminTools: true,
  license: 'KEY-123',
  token: 'eyJ...',
  recoveryKey: 'RK-1',
});

test('export: only the allowlist, never PIN, device keys, tokens, licence or recovery material', () => {
  const text = buildSettingsFile(full(), { device: 'PC-1', now: new Date('2026-11-10T08:00:00Z') });
  const data = JSON.parse(text);
  assert.equal(data.marker, SETTINGS_MARKER);
  assert.equal(data.version, 1);
  assert.equal(data.device, 'PC-1');
  assert.equal(data.exportedAt, '2026-11-10T08:00:00.000Z');
  for (const k of Object.keys(data.settings)) assert.ok(Object.hasOwn(SETTINGS_FILE_KEYS, k), `${k} is not allowlisted`);
  for (const k of SECRET_KEYS) assert.ok(!Object.hasOwn(data.settings, k), `${k} must not be in the file`);
  for (const secret of ['secret-key', 'KEY-123', 'eyJ', 'RK-1', '"hash"', 'Keevault-Persoenlich', 'claude']) assert.ok(!text.includes(secret), `${secret} leaked`);
  // Vault entries keep only name, address, tenant.
  assert.deepEqual(data.settings.containers, [{ name: 'Team', vaultUrl: 'https://kv-team.vault.azure.net/', tenantId: '11111111-2222-3333-4444-555555555555' }]);
});

test('allowlist equals SYNC_KEYS in desktop/config.js without the break-glass accounts (no more, no less)', () => {
  const src = fs.readFileSync(new URL('../desktop/config.js', import.meta.url), 'utf8');
  const list = /export const SYNC_KEYS = \[([\s\S]*?)\];/.exec(src)[1];
  const sync = [...list.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).filter((k) => !NEVER_IN_FILE.includes(k)).sort();
  assert.deepEqual(Object.keys(SETTINGS_FILE_KEYS).sort(), sync);
  assert.ok(!Object.hasOwn(SETTINGS_FILE_KEYS, 'breakGlass'));
  for (const k of SECRET_KEYS) assert.ok(!Object.hasOwn(SETTINGS_FILE_KEYS, k), k);
});

test('round trip: export → import gives the same settings', () => {
  const text = buildSettingsFile(full(), { device: 'PC-1' });
  const read = parseSettingsFile(text);
  assert.deepEqual(read.settings, pickSettings(full()));
  assert.deepEqual(read.dropped, []);
  assert.equal(read.device, 'PC-1');
  // With a BOM (Notepad) too.
  assert.deepEqual(parseSettingsFile(`\uFEFF${text}`).settings, read.settings);
});

test('import: foreign and invalid keys are dropped', () => {
  const file = {
    marker: SETTINGS_MARKER, version: 1, device: 'X', exportedAt: '2026-11-10T08:00:00Z',
    settings: {
      appPin: { hash: 'x' }, personalDeviceKeys: { a: 'b' }, pinGuard: null, adminTools: true, mcpEnabled: true, approvedAgents: ['evil'], __proto__: { x: 1 },
      fileContainers: ['\\\\evil\\share\\x.kvpws'], helperExe: 'C:\\evil.exe', personalVaults: ['C:\\evil.kvpws'],
      language: 'fr', zoom: 'big', autoLockMinutes: -1, clipboardSeconds: 1e9, updateMode: 'never', unlockPrompt: 'consent',
      autoTypeKeys: 'Alt+F4', theme: 'dark', tenantId: 'not a tenant!', clientId: 'contoso.com', defaultContainer: '../../x',
      hiddenContainers: ['ok.vault.azure.net', 'C:\\Windows\\x'],
      containers: [
        { name: 'Gut', vaultUrl: 'https://kv-gut.vault.azure.net' },
        { name: 'Fremd', vaultUrl: 'https://evil.example.com/' },
        { name: 'http', vaultUrl: 'http://kv-x.vault.azure.net/' },
        { name: 'Pfad', vaultUrl: 'https://kv-x.vault.azure.net/secrets/a' },
        { name: 'Unterhost', vaultUrl: 'https://kv-x.vault.azure.net.evil.com/' },
        { name: 'Andere Cloud', vaultUrl: 'https://kv-x.vault.azure.cn/' },
        { name: 'Tenant', vaultUrl: 'https://kv-y.vault.azure.net/', tenantId: '<script>' },
        'https://kv-z.vault.azure.net/',
      ],
    },
  };
  const read = parseSettingsFile(JSON.stringify(file));
  assert.deepEqual(read.settings, { theme: 'dark', containers: [{ name: 'Gut', vaultUrl: 'https://kv-gut.vault.azure.net/' }] });
  for (const k of ['appPin', 'personalDeviceKeys', 'pinGuard', 'adminTools', 'mcpEnabled', 'approvedAgents', 'fileContainers', 'helperExe', 'personalVaults',
    'language', 'zoom', 'autoLockMinutes', 'clipboardSeconds', 'updateMode', 'unlockPrompt', 'autoTypeKeys', 'tenantId', 'clientId', 'defaultContainer',
    'hiddenContainers', 'containers']) assert.ok(read.dropped.includes(k), `${k} not reported as dropped`);
  assert.ok(!Object.hasOwn(read.settings, '__proto__') || Object.getPrototypeOf(read.settings) === Object.prototype);
});

test('import: marker, version, JSON and size are checked', () => {
  assert.throws(() => parseSettingsFile('{'), /JSON/);
  assert.throws(() => parseSettingsFile('[]'), /marker/);
  assert.throws(() => parseSettingsFile(JSON.stringify({ marker: 'other', version: 1, settings: {} })), /marker/);
  assert.throws(() => parseSettingsFile(JSON.stringify({ marker: SETTINGS_MARKER, version: 2, settings: {} })), /version/);
  assert.throws(() => parseSettingsFile(JSON.stringify({ marker: SETTINGS_MARKER, version: '1', settings: {} })), /version/);
  assert.throws(() => parseSettingsFile(JSON.stringify({ marker: SETTINGS_MARKER, version: 1, settings: [] })), /without settings/);
  assert.throws(() => parseSettingsFile(`{"marker":"${SETTINGS_MARKER}","version":1,"settings":{},"pad":"${'x'.repeat(300 * 1024)}"}`), /size/);
  const odd = parseSettingsFile(JSON.stringify({ marker: SETTINGS_MARKER, version: 1, device: 'a\u0000b', exportedAt: 'gestern', settings: {} }));
  assert.equal(odd.device, '');
  assert.equal(odd.exportedAt, '');
});

test('vault addresses only https://<name>.vault.azure.net', () => {
  assert.equal(vaultUrlOf('https://KV-Team.vault.azure.net'), 'https://kv-team.vault.azure.net/');
  for (const bad of ['http://kv.vault.azure.net/', 'https://kv.vault.azure.net.evil.com/', 'https://a.b.vault.azure.net/', 'kv-team', 'https://kv.vault.azure.net/x', 'file:///C:/x', 'https://kv.vault.azure.net:8443/']) {
    assert.equal(vaultUrlOf(bad), null, bad);
  }
});

// ---------------------------------------------------------------- #478 review (Konrad)
const BG = { '11111111-2222-3333-4444-555555555555': [{ id: 'attacker', type: 'user', displayName: 'IT Notfall', detail: 'x@evil.example' }] };
const fileWith = (settings) => JSON.stringify({ marker: SETTINGS_MARKER, version: 1, settings });

test('break-glass accounts are never written and never read (a planted file changes nothing)', () => {
  const text = buildSettingsFile({ breakGlass: BG, theme: 'dark' });
  assert.ok(!text.includes('breakGlass') && !text.includes('attacker'));
  const read = parseSettingsFile(fileWith({ breakGlass: BG, theme: 'dark' }));
  assert.ok(!Object.hasOwn(read.settings, 'breakGlass'));
  assert.ok(read.dropped.includes('breakGlass'));
  assert.ok(!Object.hasOwn(importPlan(read.settings, { breakGlass: {} }).take, 'breakGlass'));
});

test('the OneDrive copy is off until the user agrees (also for installations from before)', () => {
  const src = fs.readFileSync(new URL('../desktop/config.js', import.meta.url), 'utf8');
  assert.match(src, /\n {2}settingsCopy: null,/);
  const copy = fs.readFileSync(new URL('../desktop/main/settings-copy.js', import.meta.url), 'utf8');
  assert.match(copy, /if \(s\.settingsCopy !== true \|\| s\.settingsCopyPending\) return null;/);
});

test('import: weakening values are not taken over, stricter ones are', () => {
  const current = { autoLockMinutes: 15, clipboardSeconds: 30, unlockPrompt: 'select_account', updateMode: 'ask', updateChannel: 'stable', autoDiscover: false };
  const weak = { autoLockMinutes: 0, clipboardSeconds: 0, unlockPrompt: 'none', updateMode: 'off', updateChannel: 'beta', autoDiscover: true };
  const plan = importPlan(weak, current);
  assert.deepEqual(plan.take, {});
  assert.deepEqual(plan.refused.sort(), Object.keys(weak).sort());
  assert.deepEqual(importPlan({ autoLockMinutes: 60, clipboardSeconds: 90 }, current).refused.sort(), ['autoLockMinutes', 'clipboardSeconds']);
  const strict = { autoLockMinutes: 5, clipboardSeconds: 10, unlockPrompt: 'login', updateMode: 'auto', updateChannel: 'stable', autoDiscover: false };
  assert.deepEqual(importPlan(strict, current), { take: strict, refused: [], confirm: [] });
  // "Never" here: any limit is stricter. Values as they are here change nothing and are not refused.
  assert.deepEqual(importPlan({ autoLockMinutes: 30 }, { autoLockMinutes: 0 }).take, { autoLockMinutes: 30 });
  const same = { unlockPrompt: 'none', updateMode: 'off', updateChannel: 'beta', autoDiscover: true };
  assert.deepEqual(importPlan(same, same).refused, []);
});

test('import: default vault and hidden vaults only when no vault of the user vanishes', () => {
  const current = { containers: [{ vaultUrl: 'https://kv-mine.vault.azure.net/' }], hiddenContainers: ['kv-old.vault.azure.net'] };
  const file = { containers: [{ name: 'Neu', vaultUrl: 'https://kv-new.vault.azure.net/' }] };
  const p = (s, opts = {}) => importPlan({ ...file, ...s }, current, { knownIds: ['f-1234'], ...opts });
  assert.deepEqual(p({ defaultContainer: 'kv-mine.vault.azure.net' }).refused, []);
  assert.deepEqual(p({ defaultContainer: 'f-1234' }).refused, []);
  assert.deepEqual(p({ defaultContainer: '' }).take.defaultContainer, '');
  assert.deepEqual(p({ defaultContainer: 'kv-unknown.vault.azure.net' }).refused, ['defaultContainer']);
  // A vault new from the file as the default: only ticked as the default (with name and host) and as a vault.
  const fresh = p({ defaultContainer: 'kv-new.vault.azure.net' });
  assert.deepEqual([fresh.confirm, fresh.refused, Object.hasOwn(fresh.take, 'defaultContainer')], [['defaultContainer'], [], false]);
  assert.deepEqual(p({ defaultContainer: 'kv-new.vault.azure.net' }, { confirmed: ['defaultContainer'] }).refused, ['defaultContainer']);
  assert.equal(p({ defaultContainer: 'kv-new.vault.azure.net' }, { confirmed: ['defaultContainer'], vaults: ['kv-new.vault.azure.net'] }).take.defaultContainer, 'kv-new.vault.azure.net');
  assert.deepEqual(p({ hiddenContainers: ['kv-mine.vault.azure.net'] }).refused, ['hiddenContainers']);
  assert.deepEqual(p({ hiddenContainers: ['f-1234'] }).refused, ['hiddenContainers']);
  assert.deepEqual(p({ hiddenContainers: ['kv-old.vault.azure.net', 'kv-new.vault.azure.net', 'kv-other.vault.azure.net'] }).refused, []);
  // New vaults only when ticked one by one.
  assert.ok(!Object.hasOwn(p({}).take, 'containers'));
  assert.deepEqual(p({}, { vaults: ['kv-new.vault.azure.net'] }).take.containers, file.containers);
});

// ---------------------------------------------------------------- #478 re-review (Konrad): the file lists the user's own vault
test('import: a file with the user\'s own vault, a look-alike, hidden and default takes over none of it unticked', () => {
  const current = { containers: [{ name: 'Team', vaultUrl: 'https://kv-team.vault.azure.net/' }], defaultContainer: 'kv-team.vault.azure.net', hiddenContainers: [], sourceBadges: true, containerOrder: ['kv-team.vault.azure.net'] };
  const attack = parseSettingsFile(fileWith({
    containers: [{ name: 'Team', vaultUrl: 'https://kv-team.vault.azure.net/' }, { name: 'Team', vaultUrl: 'https://kv-team-evil.vault.azure.net/', tenantId: 'evil.onmicrosoft.com' }],
    hiddenContainers: ['kv-team.vault.azure.net'],
    defaultContainer: 'kv-team-evil.vault.azure.net',
    sourceBadges: false,
    containerOrder: ['kv-team-evil.vault.azure.net', 'kv-team.vault.azure.net'],
  })).settings;
  const plan = importPlan(attack, current, { knownIds: [{ id: 'kv-team.vault.azure.net', name: 'Team' }] });
  assert.deepEqual(plan.take, {});
  assert.deepEqual(plan.refused.sort(), ['containerOrder', 'hiddenContainers', 'sourceBadges']);
  assert.deepEqual(plan.confirm, ['defaultContainer']);
  // Even with every box ticked: the user's own vault stays visible, badges and order stay as they are.
  const all = importPlan(attack, current, { confirmed: ['defaultContainer'], vaults: ['kv-team-evil.vault.azure.net', 'kv-team.vault.azure.net'] });
  assert.ok(!Object.hasOwn(all.take, 'hiddenContainers') && !Object.hasOwn(all.take, 'sourceBadges') && !Object.hasOwn(all.take, 'containerOrder'));
  assert.deepEqual(all.take.containers.map((c) => c.vaultUrl), ['https://kv-team-evil.vault.azure.net/']); // the own vault is not "new"
});

test('import: a new vault with the name of one of the user\'s is marked and not ticked', () => {
  const current = { containers: [{ name: 'Team', vaultUrl: 'https://kv-team.vault.azure.net/' }] };
  const file = { containers: [
    { name: 'team ', vaultUrl: 'https://kv-team2.vault.azure.net/', tenantId: 'evil.onmicrosoft.com' },
    { name: 'Projekt', vaultUrl: 'https://kv-projekt.vault.azure.net/' },
    { vaultUrl: 'https://privat.vault.azure.net/' },
    { name: 'Team', vaultUrl: 'https://kv-team.vault.azure.net/' },
  ] };
  const list = newVaultsOf(file, current, { knownIds: [{ id: 'f-1234', name: 'Privat' }] });
  assert.deepEqual(list.map((c) => [c.id, c.clash, c.tenantId]), [
    ['kv-team2.vault.azure.net', true, 'evil.onmicrosoft.com'],
    ['kv-projekt.vault.azure.net', false, ''],
    ['privat.vault.azure.net', true, ''], // no name: shown as its host "privat", like the file vault "Privat"
  ]);
  // The renderer ticks only vaults without a clash (desktop/renderer/app/settings-file.js).
  const src = fs.readFileSync(new URL('../desktop/renderer/app/settings-file.js', import.meta.url), 'utf8');
  assert.match(src, /checked: !c\.clash/);
  assert.match(src, /Name schon vorhanden – anderer Tresor!/);
  assert.match(src, /Prüfe, dass du diese Tresore kennst\./);
});

test('import: another app registration only when confirmed one by one', () => {
  const current = { tenantId: 'contoso.onmicrosoft.com', clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  const file = { tenantId: 'evil.onmicrosoft.com', clientId: '99999999-bbbb-cccc-dddd-eeeeeeeeeeee' };
  const none = importPlan(file, current);
  assert.deepEqual(none.take, {});
  assert.deepEqual(none.confirm, ['tenantId', 'clientId']);
  assert.deepEqual(importPlan(file, current, { confirmed: ['clientId'] }).take, { clientId: file.clientId });
  assert.deepEqual(importPlan(file, current, { confirmed: ['tenantId', 'clientId'] }).take, file);
  assert.deepEqual(importPlan(current, current).confirm, []); // the same values ask nothing
});

test('the Keevault folder in OneDrive as a junction is recognized', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keevault-478-'));
  try {
    const od = path.join(root, 'OneDrive');
    const elsewhere = path.join(root, 'Elsewhere');
    fs.mkdirSync(od);
    fs.mkdirSync(elsewhere);
    assert.equal(await linkedCopyFolder(od), false); // no folder yet
    fs.mkdirSync(path.join(od, 'Keevault'));
    assert.equal(await linkedCopyFolder(od), false);
    fs.rmSync(path.join(od, 'Keevault'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(od, 'Keevault'), 'junction');
    assert.equal(await linkedCopyFolder(od), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
