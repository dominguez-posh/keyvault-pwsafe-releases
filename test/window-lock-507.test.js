import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #507: unlocking through the browser extension opens the vault session for the extension only; the window keeps its
// lock screen, sees no vault data and opens with the PIN without a second sign-in. Locking ends both. The flow itself
// runs in the desktop smoke (desktop/main/smoke-window-lock.js, area "pin").

const read = (p) => readFileSync(new URL(`../desktop/${p}`, import.meta.url), 'utf8');

test('#507: only lock-screen calls pass while the window is locked, and only those that read no vault', () => {
  const index = read('main/api/index.js');
  const allowed = [...index.match(/WINDOW_LOCKED_API = new Set\(\[([^\]]+)\]\)/)[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.ok(allowed.includes('verifyPin') && allowed.includes('unlock') && allowed.includes('lock') && allowed.includes('state'));
  for (const reading of ['items', 'getItem', 'containers', 'search', 'refresh', 'unlockOffline', 'signIn', 'setPin', 'healthReport', 'accessReport', 'exportVault']) {
    assert.ok(!allowed.includes(reading), reading);
  }
  // The refusal comes before the call and never through lockNow (the extension keeps its session).
  assert.match(index, /const refused = windowLockedRefusal\(method\);\n\s+if \(refused\) return refused;\n\s+try \{/);
});

test('#507: the window state while locked alone has no vaults, no account and no naming settings', () => {
  const app = read('main/api/app.js');
  assert.match(app, /if \(windowLocked\) return lockedWindowState\(settings\);/);
  assert.match(app, /const settings = lockScreenSettings\(all, forcedLanguage\(\)\);/);
  assert.match(app, /account: null, containers: \[\]/);
});

// A full settings record as config.get() returns it, with everything that must never reach the locked window.
const FULL = {
  tenantId: 'tenant-507', clientId: 'client-507', containers: [{ name: 'Tresor Geheim', vaultUrl: 'https://kv507.vault.azure.net' }],
  policyContainers: [{ name: 'Policy Tresor' }], hiddenContainers: ['kv-hidden'], containerOrder: ['kv507'], defaultContainer: 'kv507',
  fileContainers: [{ name: 'Datei Tresor', path: 'C:\\x.kvpws' }], fileIds: { a: 1 }, fileIdNotes: { a: { name: 'Notiz' } }, fileEmail: 'a@b.c',
  approvedBrowsers: ['edge'], approvedAgents: ['agent-507'], mcpScopes: [{ vaultId: 'kv507' }], agentRules: { a: {} }, mcpTrusted: [{ title: 'Eintrag 507' }],
  appPin: { hash: 'h' }, pinGuard: { failures: 1 }, personalDeviceKeys: { p: 'k' }, personalVaults: ['C:\\p.kvpws'], personalRecoveryPending: { p: 'r1' },
  personalRecoveryRenewed: { p: 'r2' }, breakGlass: { 'tenant-507': [{ displayName: 'Notfall' }] }, adminTools: true, mcpEnabled: true,
  language: 'de', theme: 'dark', zoom: 1.1, transparency: 'strong', updateMode: 'ask', updateChannel: 'beta', selfUpdate: true,
  otherInstallDismissed: 'x|1', requirePin: true, passkeyPin: true, entraUsed: true, setupOffered: true, enforced: ['tenantId'],
};
const NEVER = ['tenantId', 'clientId', 'breakGlass', 'personalVaults', 'personalRecoveryPending', 'personalRecoveryRenewed', 'mcpTrusted', 'appPin',
  'pinGuard', 'personalDeviceKeys', 'fileIds', 'fileIdNotes', 'fileEmail', 'approvedAgents', 'agentRules', 'mcpScopes', 'defaultContainer', 'adminTools'];

test('#507 review N3: the locked window gets an allowlist of settings – nothing that names vaults, tenants, agents or the PIN', async () => {
  const { lockScreenSettings, LOCK_SCREEN_SETTINGS } = await import('../desktop/window-lock-settings.js');
  const s = lockScreenSettings(FULL);
  for (const key of NEVER) assert.ok(!Object.hasOwn(s, key), key);
  for (const list of ['containers', 'policyContainers', 'fileContainers', 'hiddenContainers', 'containerOrder']) assert.deepEqual(s[list], [], list);
  const text = JSON.stringify(s);
  for (const name of ['tenant-507', 'client-507', 'Tresor Geheim', 'Policy Tresor', 'Datei Tresor', 'agent-507', 'Eintrag 507', 'Notfall', 'kv507']) {
    assert.ok(!text.includes(name), name);
  }
  assert.equal(s.language, 'de');
  assert.equal(s.updateChannel, 'beta');
  assert.equal(lockScreenSettings(FULL, 'en').language, 'en', 'a language forced by policy wins');
  // A setting added later stays out until it is put on the list.
  assert.ok(!Object.hasOwn(lockScreenSettings({ ...FULL, someNewSecret: 'x' }), 'someNewSecret'));
  for (const key of NEVER) assert.ok(!LOCK_SCREEN_SETTINGS.includes(key), key);
});

test('#507 review N2: the locked window changes only language, view and the installation hint', async () => {
  const { lockScreenRefused } = await import('../desktop/window-lock-settings.js');
  for (const ok of [{ language: 'en' }, { otherInstallDismissed: 'x|1' }, { zoom: 1.25, theme: 'dark', transparency: 'off' }]) {
    assert.deepEqual(lockScreenRefused(ok), [], JSON.stringify(ok));
  }
  for (const bad of [{ breakGlass: {} }, { containers: [] }, { mcpEnabled: true }, { tenantId: 'x' }, { language: 'en', mcpScopes: [] }, { adminTools: true },
    { browserIntegration: false }, { personalVaults: [] }, { autoLockMinutes: 0 },
    // Review 0.9.33: update mode and channel are not changed from the locked window.
    { updateMode: 'auto' }, { updateChannel: 'beta' }, { language: 'en', updateMode: 'off' }]) {
    assert.ok(lockScreenRefused(bad).length > 0, JSON.stringify(bad));
  }
  const app = read('main/api/app.js');
  const update = app.slice(app.indexOf('updateSettings: async (patch) => {'), app.indexOf('async unlock({'));
  assert.ok(update.indexOf('lockScreenRefused(patch)') < update.indexOf('config.update(patch)'), 'refused before anything is stored');
  assert.match(update, /return windowLocked \? lockScreenSettings\(config\.get\(\), forcedLanguage\(\)\) : config\.get\(\);/);
});

test('#507: the extension unlock locks the window before the session opens; the window unlock signs in no second time', () => {
  const app = read('main/api/app.js');
  const unlock = app.slice(app.indexOf('async unlock({'), app.indexOf('async unlockOffline()'));
  assert.ok(unlock.indexOf('requirePin()') < unlock.indexOf('if (opened && windowLocked && !background)'), 'PIN checked first');
  const windowPath = unlock.slice(unlock.indexOf('if (opened && windowLocked && !background)'), unlock.indexOf('if (background && !opened)'));
  assert.match(windowPath, /setWindowLocked\(false\)/);
  assert.doesNotMatch(windowPath, /openSession|auth\.unlock|newSession|refreshAll/);
  assert.ok(unlock.indexOf('if (background && !opened) setWindowLocked(true)') < unlock.indexOf('openSession('));
  assert.doesNotMatch(app.slice(app.indexOf('export const appApi')), /\bopenSession:/, 'opening the session is no API of its own');
});

test('#507: locking ends both; the tray says "Erweiterung entsperrt"; vault events stay out of the locked window', () => {
  const session = read('main/session.js');
  const lock = session.slice(session.indexOf('export async function lockNow'), session.indexOf('function configuredContainers'));
  assert.match(lock, /setOpened\(false\);\n\s+setWindowLocked\(false\);/);
  assert.match(session, /QUIET_WHILE_WINDOW_LOCKED = new Set\(\['busy', 'progress', 'mcpTrusted'\]\)/);
  const win = read('main/window.js');
  assert.match(win, /windowLocked \? \[\{ id: 'extension-unlocked', label: t\('Erweiterung entsperrt'\), enabled: false \}/);
  assert.match(win, /label: t\('Passwort-Check'\), enabled: inWindow/);
});

test('#507 (Lucas): an agent question behind the window lock shows no names and cannot be allowed until the PIN', () => {
  const agents = read('main/agents.js');
  assert.match(agents, /const held = windowLocked && isAgentQuestion\(spec\);/);
  assert.match(agents, /send\(\{ type: 'question', id, \.\.\.\(held \? heldView\(spec\) : spec\) \}\)/);
  const view = agents.slice(agents.indexOf('const heldView'), agents.indexOf('export function revealHeldQuestions'));
  assert.doesNotMatch(view, /spec\.(agent|entry|vault|title|username|fields|changes|choices)/, 'nothing of the question but its refusal');
  assert.match(agents, /if \(heldQuestions\.has\(id\) && String\(value\) !== refusals\.get\(id\)\) throw/);
  assert.match(agents, /if \(\(spec\.pin \|\| held\) && \(!win \|\| win\.webContents\.isLoading\(\)\)\) return spec\.cancel;/);
  const app = read('main/api/app.js');
  const windowPath = app.slice(app.indexOf('if (opened && windowLocked && !background)'), app.indexOf('if (background && !opened)'));
  assert.match(windowPath, /revealHeldQuestions\(\)/);
  assert.match(read('renderer/app/requests.js'), /allow\.disabled = choice === null \|\| !!q\.held;/);
});

// #507 review N1: a Windows passkey request behind the window's lock shows no site, account, entry or vault and no
// vault list; allowing waits for the window's PIN, refusing works always; after the unlock the request shows in full.
test('#507 review N1: Windows passkey requests behind the window lock show nothing and are allowed only after the PIN', async () => {
  const { WindowsProvider } = await import('../desktop/windows-provider.js');
  const { PasskeyPinGate } = await import('../desktop/passkey-pin.js');
  const { hashPin, PinGuard } = await import('../desktop/pin.js');
  const { encode } = await import('../extension/core/cbor.js');
  const { makeCredentialData } = await import('../extension/core/webauthn.js');
  const { b64uEncode, randomBytes, sha256, utf8 } = await import('../extension/core/util.js');
  const user = { id: b64uEncode(randomBytes(16)), name: 'held507@example.com', displayName: 'Held 507' };
  const { passkey } = await makeCredentialData({ rpId: 'held507.example', rpName: 'Held Site 507', user, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] });
  const candidates = [{ containerId: 'kv507', itemId: 'e507', title: 'Geheimer Eintrag 507', passkey }];
  const vault = {
    passkeyCandidates: async (rpId, list) => (list?.length ? [] : candidates),
    getItem: async () => ({ version: 'v1', passkeys: [passkey] }),
    saveItem: async () => ({}),
    containers: async () => [{ id: 'kv507', name: 'Tresor Geheim 507', access: { write: true } }, { id: 'kv2', name: 'Zweiter Tresor 507', access: { write: true } }],
    summaries: async () => [{ type: 'login', containerId: 'kv507', id: 'e507', title: 'Geheimer Eintrag 507', username: 'held507@example.com', rpIds: [], hosts: [] }],
  };
  let locked = true;
  const s = { appPin: await hashPin('250777') };
  const pin = new PasskeyPinGate({ settings: () => s, guard: new PinGuard(), save: () => {} });
  const provider = new WindowsProvider({ vault: () => vault, isOpen: () => true, windowLocked: () => locked, actor: () => 't', show: () => {}, notify: () => {}, pin });
  const hash = await sha256(utf8('{"type":"webauthn.get"}'));
  const get = provider.request('get', { request: Buffer.from(encode(new Map([[1, 'held507.example'], [2, hash]]))).toString('base64'), transactionId: 'g' });
  const userMap = new Map([['id', randomBytes(16)], ['name', user.name], ['displayName', user.displayName]]);
  const createReq = encode(new Map([[1, hash], [2, new Map([['id', 'held507.example'], ['name', 'Held Site 507']])], [3, userMap], [4, [new Map([['type', 'public-key'], ['alg', -7]])]]]));
  const create = provider.request('create', { request: Buffer.from(createReq).toString('base64'), transactionId: 'c' });
  const settle = (p) => Promise.race([p.then(() => 'answered', () => 'failed'), new Promise((r) => setTimeout(() => r('open'), 50))]);

  // Locked: only that something waits.
  const held = await provider.list();
  assert.deepEqual(held, [{ id: 'g', kind: 'get', locked: true, held: true }, { id: 'c', kind: 'create', locked: true, held: true }]);
  const text = JSON.stringify(held);
  for (const name of ['held507', 'Held Site 507', 'Held 507', 'Geheimer Eintrag 507', 'Tresor Geheim 507', 'Zweiter Tresor 507', 'kv507']) assert.ok(!text.includes(name), name);
  // Allowing is refused (even with the right PIN), the requests stay open.
  await assert.rejects(provider.decide('g', { containerId: 'kv507', itemId: 'e507', credentialId: passkey.credentialId, pin: '250777' }), (e) => e.name === 'WindowLocked');
  await assert.rejects(provider.decide('c', { containerId: 'kv507', title: 'x' }), (e) => e.name === 'WindowLocked');
  assert.equal(await settle(get), 'open');
  assert.equal(await settle(create), 'open');
  // Refusing works behind the lock.
  await provider.decide('c', { cancel: true });
  await assert.rejects(create, /abgebrochen/i);
  // The window unlocked with the PIN: the normal request, and it can be allowed.
  locked = false;
  const full = await provider.list();
  assert.equal(full.length, 1);
  assert.equal(full[0].candidates[0].title, 'Geheimer Eintrag 507');
  assert.equal(full[0].candidates[0].container, 'Tresor Geheim 507');
  await provider.decide('g', { containerId: 'kv507', itemId: 'e507', credentialId: passkey.credentialId, pin: '250777' });
  assert.equal(await settle(get), 'answered');
});

test('#507 review N1: the app wires the window lock into the Windows provider; the lock screen offers "Ablehnen"', () => {
  assert.match(read('main.js'), /windowLocked: \(\) => windowLocked,/);
  const start = read('renderer/app/start.js');
  const lockScreen = start.slice(start.indexOf('function renderWindowLocked'), start.indexOf('export function renderLocked'));
  assert.match(lockScreen, /Eine Anmeldung mit Passkey wartet/);
  assert.match(lockScreen, /declineHeldWindowsRequests\(\)/);
});
