import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EXTENSION_ID, UPDATE_URL, EARLY_ACCESS_FEED, POLICY_KEYS, POLICY_BASES, USER_POLICY_BASES, SETTINGS_NAME, settingsValue,
  readPolicyState, readPolicies, buildReinstallOps, buildChannelOps, buildOps, canReinstall, canFix, elevatedArguments,
  runReinstallSetup, reinstallDone, COMPANY_EXTENSION_POLICIES, classifySettings, runChannelSetup, classifyForcelist,
} from '../desktop/machine-setup.js';
import { browserPathOk, browserExe, browserLaunch, restartBrowser, sessionOf, userInstallPath } from '../desktop/browser-restart.js';

// #494: "Browser-Erweiterung neu installieren" and the loosened company rule (Lucas 08.11., "gezielt lockern"): only real
// signs of management count – policies per user, cloud enrollment, a foreign ExtensionSettings, extension block/allow lists.
// Foreign Forcelist entries and unrelated HKLM policies stay untouched and do not block. Read errors stay fail-closed.

const WIN = 'C:\\Windows';
const STABLE_VALUE = `${EXTENSION_ID};${UPDATE_URL}`;
const BETA_VALUE = `${EXTENSION_ID};${EARLY_ACCESS_FEED}`;
const SERVICENOW = 'abcdefghijklmnopabcdefghijklmnop';
const SERVICENOW_VALUE = `${SERVICENOW};https://edge.microsoft.com/extensionwebstorebase/v1/crx`;
const full = (k) => k.replace(/^HKLM/i, 'HKEY_LOCAL_MACHINE').replace(/^HKCU/i, 'HKEY_CURRENT_USER');
const ROOTS = ['HKLM\\SOFTWARE', 'HKCU\\SOFTWARE'];

/**
 * A small registry behind regQuery, answering like reg.exe: keys { 'HKLM\\…': { name: [type, value] } } (parents exist
 * implicitly), fail: keys whose `/s` read fails although they exist (denied). elevate runs apply(model) when given.
 */
function fakeRegistry({ keys = {}, fail = [], apply, elevateResult = true } = {}) {
  const model = new Map(Object.entries(keys).map(([k, v]) => [k.toUpperCase(), { name: k, values: { ...v } }]));
  const calls = { elevate: [] };
  const exists = (key) => ROOTS.some((r) => r.toUpperCase() === key.toUpperCase()) || [...model.keys()].some((k) => k === key.toUpperCase() || k.startsWith(`${key.toUpperCase()}\\`));
  const children = (key) => [...new Set([...model.keys()].filter((k) => k.startsWith(`${key.toUpperCase()}\\`)).map((k) => k.slice(0, key.length + 1 + k.slice(key.length + 1).split('\\')[0].length)))];
  const block = (key) => ['', full(key), ...Object.entries(model.get(key.toUpperCase())?.values || {}).map(([n, [ty, v]]) => `    ${n}    ${ty}    ${v}`)];
  const subtree = (key) => [key.toUpperCase(), ...[...model.keys()].filter((k) => k.startsWith(`${key.toUpperCase()}\\`))].sort();
  return {
    model,
    calls,
    set(key, name, value, type = 'REG_SZ') {
      const k = key.toUpperCase();
      if (!model.has(k)) model.set(k, { name: key, values: {} });
      model.get(k).values[name] = [type, value];
    },
    del(key, name) { delete model.get(key.toUpperCase())?.values[name]; },
    get(key, name) { return model.get(key.toUpperCase())?.values[name]?.[1]; },
    async regQuery([key, flag, name]) {
      if (!exists(key)) return null;
      if (flag === '/s') return fail.includes(key) ? null : subtree(key).flatMap((k) => block(k)).join('\r\n');
      if (flag === '/v') {
        const v = model.get(key.toUpperCase())?.values[name];
        return v ? `\r\n${full(key)}\r\n    ${name}    ${v[0]}    ${v[1]}\r\n` : null;
      }
      return [...block(key), '', ...children(key).map((c) => full(model.get(c)?.name || c)), ''].join('\r\n');
    },
    async elevate(file, args) {
      calls.elevate.push({ file, args });
      if (elevateResult && apply) apply(this);
      return elevateResult;
    },
  };
}

const EDGE_LIST = POLICY_KEYS.edge;
const EDGE_BASE = POLICY_BASES.edge;

/** Lucas's device (#494): Forcelist with the ServiceNow extension and ours (old EA address), LocalNetworkAccessAllowedForUrls, nothing per user, no cloud. */
const lucasCase = (extra = {}) => ({
  keys: {
    [EDGE_LIST]: { 1: ['REG_SZ', SERVICENOW_VALUE], 2: ['REG_SZ', BETA_VALUE] },
    [`${EDGE_BASE}\\LocalNetworkAccessAllowedForUrls`]: { 1: ['REG_SZ', 'https://intranet.example.com'] },
    [EDGE_BASE]: { [SETTINGS_NAME]: ['REG_SZ', settingsValue(EARLY_ACCESS_FEED)] },
  },
  ...extra,
});

test('Lucas\'s real case: not a company, and only Keevault values are written', async () => {
  const sys = fakeRegistry(lucasCase());
  const state = await readPolicyState(sys);
  assert.deepEqual(state.foreign, { edge: false, chrome: false }, 'ServiceNow in the Forcelist and LocalNetworkAccessAllowedForUrls are no sign of management');
  const p = await readPolicies(sys);
  assert.equal(p.edge.state, 'ours');
  assert.ok(!p.edge.managed && canReinstall(p.edge), 'the button is offered');
  assert.ok(canFix(p.edge, 'edge', 'stable'), '"Jetzt beheben" (#455) works there too');

  const ops = buildReinstallOps(state, 'stable', ['edge']);
  assert.deepEqual(ops.map((o) => [o.kind, o.key, o.name]), [
    ['policy-add', EDGE_LIST, '3'], ['policy-delete', EDGE_LIST, '2'], ['settings-replace', EDGE_BASE, SETTINGS_NAME],
  ]);
  for (const o of ops) {
    assert.ok([EDGE_LIST, EDGE_BASE].includes(o.key), 'only our two places');
    assert.ok(o.value.startsWith(`${EXTENSION_ID};`) || o.value === settingsValue(UPDATE_URL), `only our values: ${o.value}`);
    assert.notEqual(o.name, '1', 'the ServiceNow entry is never touched');
  }
  const cmd = elevatedArguments(ops, WIN);
  assert.ok(!cmd.includes(SERVICENOW) && !/LocalNetworkAccess/i.test(cmd), 'the command line names nothing foreign');
  assert.ok(!/ \/v 1 /.test(cmd), 'no step on value 1');
  // the channel's feed: Early Access writes the EA feed
  assert.equal(buildReinstallOps(state, 'beta', ['edge'])[0].value, BETA_VALUE);

  // the device setup and the channel switch also see no company any more
  assert.ok(buildChannelOps(state, 'stable', true).every((o) => o.key !== EDGE_LIST || o.name !== '1'));
  assert.ok(buildOps({ ...state, cert: null }).every((o) => o.key !== EDGE_LIST || o.name !== '1'));
});

test('Lucas\'s real case run: one UAC prompt, afterwards exactly our one value, foreign entries unchanged', async () => {
  const apply = (s) => { s.set(EDGE_LIST, '3', STABLE_VALUE); s.del(EDGE_LIST, '2'); s.set(EDGE_BASE, SETTINGS_NAME, settingsValue(UPDATE_URL)); };
  const sys = fakeRegistry(lucasCase({ apply }));
  const r = await runReinstallSetup(sys, WIN, { channel: 'stable', browsers: ['edge'] });
  assert.deepEqual(r, { result: 'changed', browsers: ['edge'], company: false });
  assert.equal(sys.calls.elevate.length, 1);
  assert.equal(sys.calls.elevate[0].file, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(sys.get(EDGE_LIST, '1'), SERVICENOW_VALUE);
  assert.equal(sys.get(`${EDGE_BASE}\\LocalNetworkAccessAllowedForUrls`, '1'), 'https://intranet.example.com');
  // declined and "ran but wrote nothing"
  assert.equal((await runReinstallSetup(fakeRegistry(lucasCase({ apply, elevateResult: false })), WIN, { channel: 'stable', browsers: ['edge'] })).result, 'declined');
  assert.equal((await runReinstallSetup(fakeRegistry(lucasCase()), WIN, { channel: 'stable', browsers: ['edge'] })).result, 'failed');
  assert.equal((await runReinstallSetup(fakeRegistry(lucasCase()), null, { channel: 'stable', browsers: ['edge'] })).result, 'unavailable');
});

// CTO decision 10.11.: an older ExtensionSettings of ours (only our ID, our release repo, only our known fields) is ours.
const V29 = 'https://github.com/dominguez-posh/keyvault-pwsafe-releases/releases/download/v0.9.29/update-ea.xml';
const lucasSettings = JSON.stringify({ [EXTENSION_ID]: { update_url: V29, override_update_url: true } });

test('Lucas\'s case of 08.11.: ExtensionSettings pinned to v0.9.29/update-ea.xml is ours and gets replaced', async () => {
  const raw = (value) => ({ type: 'REG_SZ', value });
  assert.deepEqual(classifySettings(raw(lucasSettings)), { state: 'ours', feed: null });
  for (const ok of [
    { update_url: 'https://github.com/dominguez-posh/keyvault-pwsafe-releases/releases/latest/download/update.xml' },
    { update_url: V29, override_update_url: false, installation_mode: 'force_installed' },
    { update_url: V29, installation_mode: 'normal_installed' },
  ]) assert.equal(classifySettings(raw(JSON.stringify({ [EXTENSION_ID]: ok }))).state, 'ours', JSON.stringify(ok));

  const keys = { ...lucasCase().keys, [EDGE_BASE]: { [SETTINGS_NAME]: ['REG_SZ', lucasSettings] } };
  const apply = (s) => { s.set(EDGE_LIST, '3', STABLE_VALUE); s.del(EDGE_LIST, '2'); s.set(EDGE_BASE, SETTINGS_NAME, settingsValue(UPDATE_URL)); };
  const sys = fakeRegistry({ keys, apply });
  const p = await readPolicies(sys);
  assert.ok(p.edge.state === 'ours' && canReinstall(p.edge), 'the button is offered');
  assert.ok(canFix(p.edge, 'edge', 'stable'), '"Jetzt beheben" replaces it as well');
  const ops = buildReinstallOps(await readPolicyState(sys), 'stable', ['edge']);
  assert.deepEqual(ops.at(-1), { kind: 'settings-replace', key: EDGE_BASE, name: SETTINGS_NAME, value: settingsValue(UPDATE_URL), old: lucasSettings });
  assert.doesNotThrow(() => elevatedArguments(ops, WIN));
  assert.deepEqual(await runReinstallSetup(sys, WIN, { channel: 'stable', browsers: ['edge'] }), { result: 'changed', browsers: ['edge'], company: false });
  assert.equal(sys.get(EDGE_BASE, SETTINGS_NAME), settingsValue(UPDATE_URL));
});

test('everything else in ExtensionSettings stays foreign (fail-closed)', async () => {
  const raw = (value, type = 'REG_SZ') => ({ type, value });
  const ours = { update_url: V29, override_update_url: true };
  const cases = {
    'a second ID': { [EXTENSION_ID]: ours, [SERVICENOW]: { installation_mode: 'allowed' } },
    'the wildcard next to ours': { [EXTENSION_ID]: ours, '*': { installation_mode: 'blocked' } },
    'a foreign URL': { [EXTENSION_ID]: { update_url: 'https://updates.example.com/update.xml', override_update_url: true } },
    'another repo of the same owner': { [EXTENSION_ID]: { update_url: 'https://github.com/dominguez-posh/other/releases/latest/download/update.xml' } },
    'a lookalike host': { [EXTENSION_ID]: { update_url: 'https://github.com.example.com/dominguez-posh/keyvault-pwsafe-releases/releases/latest/download/update.xml' } },
    'not an update*.xml': { [EXTENSION_ID]: { update_url: 'https://github.com/dominguez-posh/keyvault-pwsafe-releases/releases/latest/download/kvpwsafe-extension.crx' } },
    'http instead of https': { [EXTENSION_ID]: { update_url: V29.replace('https:', 'http:') } },
    'an unknown field': { [EXTENSION_ID]: { ...ours, blocked_permissions: ['clipboardRead'] } },
    'no update_url': { [EXTENSION_ID]: { override_update_url: true } },
    'blocked by the company': { [EXTENSION_ID]: { ...ours, installation_mode: 'blocked' } },
    'removed by the company': { [EXTENSION_ID]: { ...ours, installation_mode: 'removed' } },
    'override as a string': { [EXTENSION_ID]: { ...ours, override_update_url: 'true' } },
  };
  for (const [name, json] of Object.entries(cases)) {
    assert.equal(classifySettings(raw(JSON.stringify(json))).state, 'company', name);
    const sys = fakeRegistry({ keys: { ...lucasCase().keys, [EDGE_BASE]: { [SETTINGS_NAME]: ['REG_SZ', JSON.stringify(json)] } } });
    assert.deepEqual(buildReinstallOps(await readPolicyState(sys), 'stable', ['edge']), [], `${name}: nothing written`);
  }
  assert.equal(classifySettings(raw(lucasSettings, 'REG_EXPAND_SZ')).state, 'company', 'another registry type');
  assert.equal(classifySettings(raw(`${lucasSettings}x`)).state, 'company', 'unreadable JSON');
});

test('reinstall without entries of ours: the new value next to foreign ones, nothing deleted', async () => {
  const sys = fakeRegistry({ keys: { [EDGE_LIST]: { 1: ['REG_SZ', SERVICENOW_VALUE] } } });
  const ops = buildReinstallOps(await readPolicyState(sys), 'stable', ['edge']);
  assert.deepEqual(ops.map((o) => [o.kind, o.name]), [['policy-add', '2'], ['settings-add', SETTINGS_NAME]], 'no ExtensionSettings yet: only added while still missing');
  // duplicates of ours from earlier releases all go, once the new one is there
  const dup = fakeRegistry({ keys: { [EDGE_LIST]: { 1: ['REG_SZ', STABLE_VALUE], 3: ['REG_SZ', `${EXTENSION_ID};https://github.com/dominguez-posh/keyvault-pwsafe-releases/releases/download/v0.9.29/update-ea.xml`] } } });
  const dupOps = buildReinstallOps(await readPolicyState(dup), 'stable', ['edge']);
  assert.deepEqual(dupOps.map((o) => [o.kind, o.name, o.keep?.name]), [['policy-add', '2', undefined], ['policy-delete', '1', '2'], ['policy-delete', '3', '2'], ['settings-add', SETTINGS_NAME, undefined]]);
  assert.ok(!reinstallDone(await readPolicyState(dup), 'stable', ['edge']), 'two values of ours are not done');
});

const companyCases = {
  'policy per user (HKCU)': { [USER_POLICY_BASES.edge]: { HomepageLocation: ['REG_SZ', 'https://intranet.example'] } },
  'foreign ExtensionSettings value': { [EDGE_BASE]: { [SETTINGS_NAME]: ['REG_SZ', JSON.stringify({ [SERVICENOW]: { installation_mode: 'blocked' } })] } },
  'ExtensionSettings as a subkey': { [`${EDGE_BASE}\\ExtensionSettings\\*`]: { installation_mode: ['REG_SZ', 'blocked'] } },
  'cloud enrollment token in the base': { [EDGE_BASE]: { EdgeManagementEnrollmentToken: ['REG_SZ', 't'] } },
  'cloud enrollment outside the base': { 'HKLM\\SOFTWARE\\Microsoft\\Edge\\Enrollment': { dmtoken: ['REG_SZ', 't'] } },
  'Forcelist entry with our ID and a foreign address': { [EDGE_LIST]: { 1: ['REG_SZ', `${EXTENSION_ID};https://updates.example.com/x.xml`] } },
  ...Object.fromEntries(COMPANY_EXTENSION_POLICIES.filter((n) => n !== SETTINGS_NAME).map((n) => [`${n} in HKLM`, { [`${EDGE_BASE}\\${n}`]: { 1: ['REG_SZ', '*'] } }])),
  'block list as a value in the base': { [EDGE_BASE]: { ExtensionInstallBlocklist: ['REG_SZ', '*'] } },
};

test('real signs of management still count: no operation, no UAC prompt, no button', async () => {
  assert.deepEqual(COMPANY_EXTENSION_POLICIES.slice(0, 4), ['ExtensionSettings', 'ExtensionInstallBlocklist', 'ExtensionInstallAllowlist', 'ExtensionAllowedTypes']);
  for (const [name, keys] of Object.entries(companyCases)) {
    const sys = fakeRegistry({ keys: { [EDGE_LIST]: { 1: ['REG_SZ', SERVICENOW_VALUE] }, ...keys } });
    const state = await readPolicyState(sys);
    assert.deepEqual(buildReinstallOps(state, 'stable', ['edge']), [], name);
    const p = await readPolicies(sys);
    assert.ok(!canReinstall(p.edge), `${name}: no button`);
    assert.equal((await runReinstallSetup(sys, WIN, { channel: 'stable', browsers: ['edge'] })).result, 'company', name);
    assert.equal(sys.calls.elevate.length, 0, `${name}: no UAC prompt`);
  }
  // the waiver of the IT (KV_NO_POLICY)
  const waived = fakeRegistry({ keys: { 'HKLM\\SOFTWARE\\Keevault': { NoExtensionPolicy: ['REG_DWORD', '0x1'] } } });
  assert.deepEqual(buildReinstallOps(await readPolicyState(waived), 'stable', ['edge']), []);
});

test('a read error stays fail-closed', async () => {
  const sys = fakeRegistry(lucasCase({ fail: [EDGE_BASE] }));
  const state = await readPolicyState(sys);
  assert.equal(state.foreign.edge, true, 'an unreadable policy tree counts as the company\'s');
  assert.deepEqual(buildReinstallOps(state, 'stable', ['edge']), []);
  const perUser = fakeRegistry(lucasCase({ keys: { ...lucasCase().keys, [USER_POLICY_BASES.edge]: {} }, fail: [USER_POLICY_BASES.edge] }));
  assert.deepEqual(buildReinstallOps(await readPolicyState(perUser), 'stable', ['edge']), [], 'per user as well');
});

test('elevated command: a deletion only of our value, guarded by findstr, and only once the new one is in place', () => {
  const add = { kind: 'policy-add', key: EDGE_LIST, name: '3', value: STABLE_VALUE };
  const del = { kind: 'policy-delete', key: EDGE_LIST, name: '2', value: BETA_VALUE, keep: { name: '3', value: STABLE_VALUE } };
  const cmd = elevatedArguments([add, del], WIN);
  assert.ok(cmd.includes('"C:\\Windows\\System32\\findstr.exe" /L /C:"REG_SZ    '), cmd);
  const step = cmd.split(' & ')[1];
  assert.ok(step.indexOf(`/v 3 2>nul`) < step.indexOf(`/v 2 2>nul`) && step.indexOf(`/v 2 2>nul`) < step.indexOf('delete'), 'the new value is checked first, then the old one, then deleted');
  assert.ok(!/powershell|\.ps1/i.test(cmd));
  for (const bad of [
    { ...del, value: SERVICENOW_VALUE },
    { ...del, keep: undefined },
    { ...del, keep: { name: '3', value: SERVICENOW_VALUE } },
    { ...del, keep: { name: '2', value: STABLE_VALUE } },
    { ...del, key: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallBlocklist' },
    { ...del, name: '2" & calc & "' },
  ]) assert.throws(() => elevatedArguments([bad], WIN), JSON.stringify(bad));
});

test('browser restart: only the browser of the signed-in user, windows first, then the rest, then --restore-last-session', { skip: process.env.SystemRoot?.toLowerCase() !== 'c:\\windows' }, async () => {
  assert.ok(browserPathOk('edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'));
  assert.ok(!browserPathOk('edge', 'C:\\Users\\x\\msedge.exe.bat'));
  assert.ok(!browserPathOk('edge', 'C:\\x\\..\\msedge.exe'));
  assert.ok(!browserPathOk('edge', '\\\\server\\share\\msedge.exe'));
  assert.ok(!browserPathOk('edge', 'C:\\x\\chrome.exe'));
  assert.ok(!browserPathOk('firefox', 'C:\\x\\firefox.exe'));

  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const fake = (counts) => {
    const log = { run: [], start: [] };
    return {
      log,
      regQuery: async ([key]) => (key.startsWith('HKLM') ? `\r\n${full(key)}\r\n    (Standard)    REG_SZ    ${exe}\r\n` : null),
      exists: (f) => f === exe,
      run: async (file, args) => {
        log.run.push([file, ...args]);
        if (file.endsWith('tasklist.exe')) return { stdout: Array.from({ length: counts.length > 1 ? counts.shift() : counts[0] }, () => '"msedge.exe","1","Console","1","1 K"').join('\r\n') };
        return { stdout: '' };
      },
      start: (file, args) => log.start.push([file, ...args]),
      wait: async () => {},
      user: () => 'tester',
      session: async () => '1',
      localAppData: () => 'C:\\Users\\tester\\AppData\\Local',
    };
  };
  const only = ['/FI', 'USERNAME eq tester', '/FI', 'SESSION eq 1'];
  assert.equal(await browserExe('edge', fake([0])), exe);
  // running, the windows close in time
  let sys = fake([5, 0]);
  assert.deepEqual(await restartBrowser('edge', sys), { ok: true });
  const kills = sys.log.run.filter((r) => r[0].endsWith('taskkill.exe'));
  assert.deepEqual(kills, [['C:\\Windows\\System32\\taskkill.exe', ...only, '/IM', 'msedge.exe', '/T']]);
  assert.ok(sys.log.run.filter((r) => r[0].endsWith('tasklist.exe')).every((r) => r.includes('SESSION eq 1')), 'counted only in this session');
  assert.deepEqual(sys.log.start, [[exe, '--restore-last-session']]);
  // background processes stay: forced end, only msedge.exe of this user in this session, without its child programs (no /T)
  sys = fake([5, ...Array(13).fill(2), 0]);
  assert.deepEqual(await restartBrowser('edge', sys), { ok: true });
  assert.deepEqual(sys.log.run.filter((r) => r[0].endsWith('taskkill.exe')).at(-1), ['C:\\Windows\\System32\\taskkill.exe', ...only, '/IM', 'msedge.exe', '/F']);
  // cannot be ended: not started again
  sys = fake([3]);
  assert.deepEqual(await restartBrowser('edge', sys), { ok: false, reason: 'running' });
  assert.deepEqual(sys.log.start, []);
  // not running: just started
  sys = fake([0]);
  assert.deepEqual(await restartBrowser('edge', sys), { ok: true });
  assert.ok(!sys.log.run.some((r) => r[0].endsWith('taskkill.exe')));
  assert.deepEqual(await restartBrowser('firefox', fake([0])), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await restartBrowser('chrome', { ...fake([0]), exists: () => false }), { ok: false, reason: 'missing' });
});

test('the window cannot end a browser on its own: only right after a successful reinstall, once', () => {
  const src = readFileSync(new URL('../desktop/main/extension-reinstall.js', import.meta.url), 'utf8');
  assert.match(src, /restartAllowed\.has\(b\)/);
  assert.match(src, /restartAllowed = new Set\(restartable\);\s*return \{ result: 'changed'/);
  const fn = src.slice(src.indexOf('export async function restartBrowsersAndCheck'));
  assert.ok(fn.indexOf('restartAllowed = new Set();') < fn.indexOf('restartBrowser(b)'), 'the permission is used up before any restart');
  assert.match(readFileSync(new URL('../desktop/browser-restart.js', import.meta.url), 'utf8'), /'--restore-last-session'/);
});

// Konrad's four hardenings of #494 (review 10.11.).

const COMPANY_SETTINGS = JSON.stringify({ [SERVICENOW]: { installation_mode: 'blocked' } });

test('hardening 1: ExtensionSettings is replaced only while it still holds the value read before', async () => {
  const state = await readPolicyState(fakeRegistry(lucasCase()));
  const op = buildReinstallOps(state, 'stable', ['edge']).at(-1);
  assert.deepEqual(op, { kind: 'settings-replace', key: EDGE_BASE, name: SETTINGS_NAME, value: settingsValue(UPDATE_URL), old: settingsValue(EARLY_ACCESS_FEED) });
  const step = elevatedArguments([op], WIN);
  const guard = `"C:\\Windows\\System32\\findstr.exe" /L /X /C:"    ${SETTINGS_NAME}    REG_SZ    ${settingsValue(EARLY_ACCESS_FEED).replace(/"/g, '\\"')}" >nul && `;
  assert.ok(step.includes(guard), step);
  assert.ok(step.indexOf(guard) < step.indexOf(' add '), 'checked before it is written');
  // the channel switch ("Jetzt beheben") carries the value read as well
  assert.equal(buildChannelOps(state, 'stable', false).find((o) => o.kind === 'settings-replace').old, settingsValue(EARLY_ACCESS_FEED));
  // missing stays "query || add"
  const add = elevatedArguments([{ kind: 'settings-add', key: EDGE_BASE, name: SETTINGS_NAME, value: settingsValue(UPDATE_URL) }], WIN);
  assert.ok(add.includes(`/v ${SETTINGS_NAME} >nul 2>&1 || `) && !add.includes('findstr'), add);
  // no replacement without the value read, with a foreign one, or with characters cmd.exe treats specially
  for (const old of [undefined, COMPANY_SETTINGS, settingsValue(UPDATE_URL).replace('true', 'true&calc'), `${settingsValue(UPDATE_URL)}%x%`]) {
    assert.throws(() => elevatedArguments([{ ...op, old }], WIN), String(old));
  }
});

test('hardening 1: a policy changed between reading and writing stays and the result says so', async () => {
  // The company sets its own ExtensionSettings after Keevault read it: the guarded step finds another value and writes nothing.
  const apply = (s) => { s.set(EDGE_LIST, '3', STABLE_VALUE); s.del(EDGE_LIST, '2'); s.set(EDGE_BASE, SETTINGS_NAME, COMPANY_SETTINGS); };
  const sys = fakeRegistry(lucasCase({ apply }));
  assert.deepEqual(await runReinstallSetup(sys, WIN, { channel: 'stable', browsers: ['edge'] }), { result: 'meanwhile', browsers: ['edge'], company: false });
  assert.equal(sys.get(EDGE_BASE, SETTINGS_NAME), COMPANY_SETTINGS, 'the new policy is not overwritten');
  // a Forcelist value of ours that someone rewrote in the meantime counts as well
  const rewritten = fakeRegistry(lucasCase({ apply: (s) => { s.set(EDGE_LIST, '3', STABLE_VALUE); s.set(EDGE_LIST, '2', SERVICENOW_VALUE); s.set(EDGE_BASE, SETTINGS_NAME, settingsValue(UPDATE_URL)); } }));
  assert.equal((await runReinstallSetup(rewritten, WIN, { channel: 'stable', browsers: ['edge'] })).result, 'meanwhile');
  // the channel switch reports it too
  const channel = fakeRegistry(lucasCase({ apply: (s) => { s.set(EDGE_LIST, '2', STABLE_VALUE); s.set(EDGE_BASE, SETTINGS_NAME, COMPANY_SETTINGS); } }));
  assert.equal((await runChannelSetup(channel, WIN, { channel: 'stable' })).result, 'meanwhile');
  // declined: nothing ran, no "meanwhile"
  assert.equal((await runReinstallSetup(fakeRegistry(lucasCase({ apply, elevateResult: false })), WIN, { channel: 'stable', browsers: ['edge'] })).result, 'declined');
  // the window shows the notice
  for (const file of ['../desktop/renderer/app/ext-reinstall.js', '../desktop/renderer/app/ext-hint.js']) {
    assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /'meanwhile'\) return \{ kind: 'error', text: t\('Nicht übernommen: Die Richtlinie wurde inzwischen geändert\./, file);
  }
});

test('hardening 2: Forcelist value names other than plain numbers are foreign and never touched', async () => {
  for (const name of ['/va', '1 /va', 'x1']) {
    const sys = fakeRegistry({ keys: { [EDGE_LIST]: { 1: ['REG_SZ', SERVICENOW_VALUE], [name]: ['REG_SZ', BETA_VALUE] } } });
    const state = await readPolicyState(sys);
    if (!name.includes(' ')) { // reg.exe never prints a name with a space as one name; the parser cannot read it back
      assert.equal(classifyForcelist(state.policies.edge).state, 'theirs', name);
      assert.equal((await readPolicies(sys)).edge.state, 'company', `${name}: counts as foreign`);
      assert.deepEqual(buildReinstallOps(state, 'stable', ['edge']), [], `${name}: nothing deleted or written`);
      assert.ok(buildOps({ ...state, cert: null }).every((o) => o.name !== name), `${name}: the device setup leaves it`);
      assert.ok(buildChannelOps(state, 'stable', true).every((o) => o.name !== name), `${name}: the channel switch leaves it`);
    }
    const del = { kind: 'policy-delete', key: EDGE_LIST, name, value: BETA_VALUE, keep: { name: '3', value: STABLE_VALUE } };
    assert.throws(() => elevatedArguments([del], WIN), `delete ${name}`);
    assert.throws(() => elevatedArguments([{ kind: 'policy-replace', key: EDGE_LIST, name, value: STABLE_VALUE }], WIN), `replace ${name}`);
    assert.throws(() => elevatedArguments([{ ...del, name: '2', keep: { name, value: STABLE_VALUE } }], WIN), `keep ${name}`);
  }
  assert.doesNotThrow(() => elevatedArguments([{ kind: 'policy-replace', key: EDGE_LIST, name: '12', value: STABLE_VALUE }], WIN));
});

const LOCAL = 'C:\\Users\\tester\\AppData\\Local';
const restartFake = ({ hklm = null, hkcu = null, files = [], session = '1' } = {}) => {
  const log = { run: [], start: [] };
  const answer = (key, file) => `\r\n${full(key)}\r\n    (Standard)    REG_SZ    ${file}\r\n`;
  return {
    log,
    regQuery: async ([key]) => (key.startsWith('HKLM') ? (hklm ? answer(key, hklm) : null) : (hkcu ? answer(key, hkcu) : null)),
    exists: (f) => files.includes(f),
    run: async (file, args) => { log.run.push([file, ...args]); return { stdout: '' }; },
    start: (file, args) => log.start.push([file, ...args]),
    wait: async () => {},
    user: () => 'tester',
    session: async () => session,
    localAppData: () => LOCAL,
  };
};

test('hardening 3: a start path from HKCU only when it is the per-user installation below %LOCALAPPDATA%', { skip: process.env.SystemRoot?.toLowerCase() !== 'c:\\windows' }, async () => {
  const chrome = `${LOCAL}\\Google\\Chrome\\Application\\chrome.exe`;
  assert.equal(userInstallPath('chrome', `${LOCAL}\\`), chrome);
  assert.equal(userInstallPath('edge', LOCAL), `${LOCAL}\\Microsoft\\Edge\\Application\\msedge.exe`);
  assert.equal(userInstallPath('chrome', ''), null);
  assert.equal(userInstallPath('chrome', '\\\\server\\share'), null);
  // the real per-user Chrome: restarted from there
  let sys = restartFake({ hkcu: chrome, files: [chrome] });
  assert.deepEqual(await restartBrowser('chrome', sys), { ok: true });
  assert.deepEqual(sys.log.start, [[chrome, '--restore-last-session']]);
  // a prepared HKCU registration: no restart, nothing ended, the user restarts the browser himself
  const prepared = ['C:\\Users\\tester\\AppData\\Roaming\\x\\chrome.exe', `${LOCAL}\\Temp\\chrome.exe`, `${LOCAL}\\Google\\Chrome\\Application\\..\\..\\..\\Temp\\chrome.exe`,
    'D:\\Google\\Chrome\\Application\\chrome.exe', `${LOCAL}\\Google\\Chrome\\Application\\chrome.exe.bat`];
  for (const hkcu of prepared) {
    sys = restartFake({ hkcu, files: [hkcu, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'] });
    assert.deepEqual(await browserLaunch('chrome', sys), { reason: 'untrusted' }, hkcu);
    assert.deepEqual(await restartBrowser('chrome', sys), { ok: false, reason: 'untrusted' }, hkcu);
    assert.deepEqual(sys.log, { run: [], start: [] }, `${hkcu}: nothing ended, nothing started`);
  }
  // HKLM (admins only) still comes first; without any registration the known install folders
  const machine = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert.deepEqual(await browserLaunch('chrome', restartFake({ hklm: machine, hkcu: prepared[0], files: [machine] })), { exe: machine });
  assert.deepEqual(await browserLaunch('chrome', restartFake({ files: [machine] })), { exe: machine });
  assert.deepEqual(await browserLaunch('chrome', restartFake()), { reason: 'missing' });
});

test('hardening 4: taskkill only in this session, /T only for the gentle request, the forced end without child programs', { skip: process.env.SystemRoot?.toLowerCase() !== 'c:\\windows' }, async () => {
  assert.equal(sessionOf('"electron.exe","4242","Console","3","120.000 K"\r\n'), '3');
  assert.equal(sessionOf('INFO: No tasks are running which match the specified criteria.'), null);
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const sys = restartFake({ hklm: exe, files: [exe], session: '3' });
  sys.run = async (file, args) => { sys.log.run.push([file, ...args]); return { stdout: file.endsWith('tasklist.exe') ? '"msedge.exe","1","RDP-Tcp#0","3","1 K"' : '' }; };
  assert.deepEqual(await restartBrowser('edge', sys), { ok: false, reason: 'running' });
  const kills = sys.log.run.filter((r) => r[0].endsWith('taskkill.exe')).map((r) => r.slice(1));
  assert.deepEqual(kills, [
    ['/FI', 'USERNAME eq tester', '/FI', 'SESSION eq 3', '/IM', 'msedge.exe', '/T'],
    ['/FI', 'USERNAME eq tester', '/FI', 'SESSION eq 3', '/IM', 'msedge.exe', '/F'],
  ]);
  assert.ok(sys.log.run.every((r) => r.includes('SESSION eq 3')), 'every tasklist and taskkill call is limited to this session');
  // session unknown: nothing is ended
  for (const session of [null, '1 /FI x']) {
    const unknown = restartFake({ hklm: exe, files: [exe], session });
    assert.deepEqual(await restartBrowser('edge', unknown), { ok: false, reason: 'unavailable' });
    assert.deepEqual(unknown.log, { run: [], start: [] });
  }
});
