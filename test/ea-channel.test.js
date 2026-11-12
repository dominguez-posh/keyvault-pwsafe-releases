import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXTENSION_ID, UPDATE_URL, EARLY_ACCESS_FEED, POLICY_KEYS, POLICY_BASES, feedFor, settingsValue, classifySettings, parseSettingsValue, browserPolicy,
  isAligned, buildChannelOps, buildOps, elevatedArguments, readPolicies, runChannelSetup,
  USER_POLICY_BASES, CLOUD_MARKS, foreignInTree, parseRegTree, canFix, readPolicyState,
} from '../desktop/machine-setup.js';
import { EARLY_ACCESS_FEED as RELEASE_EA, EXTENSION_UPDATE, checkEarlyAccessFeed, earlyAccessFeedXml, extensionCodebase } from '../scripts/release-urls.mjs';

// #455 on top of #395: the update channel of the app switches the browser policies of the extension. The elevated part is
// machine-setup.js (only reg.exe from C:\Windows with fixed values); no script from the installation folder.

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const WIN = 'C:\\Windows';
const STABLE_VALUE = `${EXTENSION_ID};${UPDATE_URL}`;
const BETA_VALUE = `${EXTENSION_ID};${EARLY_ACCESS_FEED}`;
const entry = (value, name = '1') => ({ name, value });
const raw = (value, type = 'REG_SZ') => ({ type, value });
const FOREIGN_EXT = 'abcdefghijklmnopabcdefghijklmnop';

test('the feed addresses are the fixed ones, in the release script and in the app', () => {
  assert.equal(EARLY_ACCESS_FEED, 'https://raw.githubusercontent.com/dominguez-posh/keyvault-pwsafe-releases/early-access/update-ea.xml');
  assert.equal(RELEASE_EA, EARLY_ACCESS_FEED);
  assert.equal(UPDATE_URL, EXTENSION_UPDATE.manifest);
  assert.equal(feedFor('beta'), EARLY_ACCESS_FEED);
  assert.equal(feedFor('stable'), UPDATE_URL);
  assert.equal(feedFor('https://evil.example/x.xml'), UPDATE_URL, 'no free choice');
});

test('release.mjs: update-ea.xml only after the release exists, and a hotfix pulls it along (#455 point 4)', () => {
  const release = read('../scripts/release.mjs');
  const create = release.indexOf("run('gh', ['release', 'create'");
  const feed = release.indexOf("step('Early-Access-Feed (update-ea.xml)'");
  assert.ok(create > 0 && feed > create, 'the feed is written and pushed after the release was created');
  const feedStep = release.slice(feed);
  assert.ok(!/if \(earlyAccess\)/.test(feedStep), 'not only for Early Access: a Prod hotfix moves the feed as well');
  assert.match(feedStep, /earlyAccessFeedXml\(/);
  assert.match(feedStep, /push', 'origin', 'HEAD:early-access'/);
  // before the release the feed is only carried over unchanged (the export empties the folder)
  const before = release.slice(0, create);
  assert.ok(!/earlyAccessFeedXml\(|checkEarlyAccessFeed\(/.test(before), 'no new feed before the release');
  assert.match(before, /if \(oldFeed\) writeFileSync\(feedFile, oldFeed\)/);
});

test('the feed names the CRX of its own tag, also when it is built from a Prod hotfix', () => {
  const xml = `<updatecheck codebase='${extensionCodebase('0.9.30', true)}' version='0.9.30' />`;
  assert.equal(checkEarlyAccessFeed(xml, '0.9.30'), xml);
  const prod = `<updatecheck codebase='${EXTENSION_UPDATE.crx}' version='0.9.30' />`;
  assert.throws(() => checkEarlyAccessFeed(prod, '0.9.30'));
  assert.equal(earlyAccessFeedXml(prod, '0.9.30'), xml);
  assert.throws(() => earlyAccessFeedXml(xml, '0.9.31'));
});

test('ExtensionSettings: only the exact fixed value of one of our two feeds is ours, everything else is the company (#455 point 2)', () => {
  assert.deepEqual(classifySettings(null), { state: 'missing' });
  assert.deepEqual(classifySettings(raw(settingsValue(UPDATE_URL))), { state: 'ours', feed: UPDATE_URL });
  assert.deepEqual(classifySettings(raw(settingsValue(EARLY_ACCESS_FEED))), { state: 'ours', feed: EARLY_ACCESS_FEED });
  const ours = JSON.parse(settingsValue(UPDATE_URL));
  const cases = [
    JSON.stringify({ ...ours, [FOREIGN_EXT]: { installation_mode: 'blocked' } }), // a foreign key next to ours
    JSON.stringify({ '*': { installation_mode: 'blocked' } }),
    JSON.stringify({ [FOREIGN_EXT]: { installation_mode: 'blocked' } }),
    JSON.stringify({ [EXTENSION_ID]: { installation_mode: 'blocked' } }),
    JSON.stringify({ [EXTENSION_ID]: { update_url: 'https://updates.example.com/x.xml', override_update_url: true } }),
    // (#494: our ID alone with our release repo and our known fields counts as an older value of ours, see ext-reinstall-494.test.js)
    JSON.stringify({ [EXTENSION_ID]: { update_url: UPDATE_URL, override_update_url: true, installation_mode: 'blocked' } }),
    '{kein json',
    '',
    '[]',
  ];
  for (const c of cases) assert.equal(classifySettings(raw(c)).state, 'company', c);
  assert.equal(classifySettings(raw(settingsValue(UPDATE_URL), 'REG_EXPAND_SZ')).state, 'company', 'another registry type');
  assert.deepEqual(parseSettingsValue('\r\nHKEY\\x\r\n    ExtensionSettings    REG_SZ    {"a":1}\r\n'), { type: 'REG_SZ', value: '{"a":1}' });
  assert.equal(parseSettingsValue('nothing'), null);
});

test('policy of one browser: a foreign Forcelist entry or any foreign ExtensionSettings makes all of it the company\'s', () => {
  assert.equal(browserPolicy(null, null).state, 'none');
  assert.equal(browserPolicy([entry(STABLE_VALUE)], null).state, 'ours');
  assert.equal(browserPolicy([entry(BETA_VALUE)], raw(settingsValue(EARLY_ACCESS_FEED))).state, 'ours');
  assert.equal(browserPolicy([entry(`${EXTENSION_ID};https://updates.example.com/crx.xml`)], null).state, 'company');
  assert.equal(browserPolicy([entry(STABLE_VALUE)], raw(JSON.stringify({ [FOREIGN_EXT]: {} }))).state, 'company');
  assert.equal(browserPolicy([entry(`${FOREIGN_EXT};https://x.example/o.xml`)], null).state, 'none', 'another extension is not our business');
  const aligned = browserPolicy([entry(BETA_VALUE)], raw(settingsValue(EARLY_ACCESS_FEED)));
  assert.ok(isAligned(aligned, 'beta'));
  assert.ok(!isAligned(aligned, 'stable'));
  assert.ok(!isAligned(browserPolicy([entry(BETA_VALUE)], null), 'beta'), 'ExtensionSettings missing: not aligned yet');
});

const both = (list, settings = null) => ({ policies: { edge: list, chrome: list }, settings: { edge: settings, chrome: settings } });

test('plan: switching touches only policies of ours, creating needs the explicit "create"', () => {
  const stable = both([entry(STABLE_VALUE)], raw(settingsValue(UPDATE_URL)));
  assert.deepEqual(buildChannelOps(stable, 'stable', false), []);
  const toBeta = buildChannelOps(stable, 'beta', false);
  assert.deepEqual(toBeta.map((o) => o.kind), ['policy-replace', 'settings-replace', 'policy-replace', 'settings-replace']);
  assert.deepEqual(toBeta.map((o) => o.value), [BETA_VALUE, settingsValue(EARLY_ACCESS_FEED), BETA_VALUE, settingsValue(EARLY_ACCESS_FEED)]);
  assert.deepEqual(buildChannelOps(both(null), 'beta', false), [], 'no policy of ours: a plain switch writes nothing');
  const created = buildChannelOps(both(null), 'beta', true);
  assert.deepEqual(created.map((o) => o.kind), ['policy-add', 'settings-add', 'policy-add', 'settings-add']);
  assert.deepEqual(created.filter((o) => o.kind === 'settings-add').map((o) => o.key), [POLICY_BASES.edge, POLICY_BASES.chrome]);
});

test('plan: a foreign key anywhere means nothing is written, neither switching nor creating (#455 point 2)', () => {
  const foreignSettings = raw(JSON.stringify({ [EXTENSION_ID]: JSON.parse(settingsValue(UPDATE_URL))[EXTENSION_ID], [FOREIGN_EXT]: { installation_mode: 'allowed' } }));
  for (const create of [false, true]) {
    assert.deepEqual(buildChannelOps(both([entry(STABLE_VALUE)], foreignSettings), 'beta', create), []);
    assert.deepEqual(buildChannelOps(both(null, foreignSettings), 'beta', create), []);
    assert.deepEqual(buildChannelOps(both([entry(`${EXTENSION_ID};https://updates.example.com/crx.xml`)]), 'beta', create), []);
  }
  // one browser is the company's, the other is ours: only ours is switched
  const mixed = { policies: { edge: [entry(`${EXTENSION_ID};https://x.example/u.xml`)], chrome: [entry(STABLE_VALUE)] }, settings: { edge: null, chrome: raw(settingsValue(UPDATE_URL)) } };
  const ops = buildChannelOps(mixed, 'beta', true);
  assert.ok(ops.length > 0 && ops.every((o) => o.key === POLICY_KEYS.chrome || o.key === POLICY_BASES.chrome));
  // the device setup (#395) also leaves a browser alone whose ExtensionSettings is foreign
  assert.deepEqual(buildOps({ cert: null, policies: { edge: null, chrome: null }, settings: { edge: raw('{"*":{}}'), chrome: raw('{"*":{}}') } }), []);
});

test('plan: the remembered waiver (KV_NO_POLICY) is checked before anything is created or switched (#455 point 3)', () => {
  for (const state of [both(null), both([entry(STABLE_VALUE)], raw(settingsValue(UPDATE_URL)))]) {
    for (const create of [false, true]) assert.deepEqual(buildChannelOps({ ...state, policyBlocked: true }, 'beta', create), []);
  }
  assert.ok(buildChannelOps({ ...both(null), policyBlocked: false }, 'beta', true).length > 0);
});

test('elevated command line for ExtensionSettings: only reg.exe, only the two fixed values, only the two browser keys', () => {
  const ops = buildChannelOps(both(null), 'beta', true);
  const args = elevatedArguments(ops, WIN);
  assert.ok(!/setup\.ps1|powershell|ExecutionPolicy|Bypass/i.test(args));
  const programs = [...args.matchAll(/"([^"]+\.exe)"/g)].map((m) => m[1].toLowerCase());
  assert.ok(programs.length >= 8 && programs.every((p) => p === 'c:\\windows\\system32\\reg.exe'));
  assert.ok(args.includes(`/d "${settingsValue(EARLY_ACCESS_FEED).replace(/"/g, '\\"')}"`));
  assert.match(args, /query "HKLM[^"]*Edge" \/v ExtensionSettings >nul 2>&1 \|\| /, 'a new value only where the name is still free');
  const op = { kind: 'settings-replace', key: POLICY_BASES.edge, name: 'ExtensionSettings', value: settingsValue(UPDATE_URL), old: settingsValue(EARLY_ACCESS_FEED) };
  assert.doesNotThrow(() => elevatedArguments([op], WIN));
  assert.throws(() => elevatedArguments([{ ...op, old: undefined }], WIN), /unexpected/, 'a replacement without the value read before (#494)');
  assert.throws(() => elevatedArguments([{ ...op, value: '{"a":"b"} & calc' }], WIN), /unexpected/, 'not a fixed value');
  assert.throws(() => elevatedArguments([{ ...op, value: settingsValue('https://evil.example/u.xml') }], WIN), /unexpected/, 'not one of our two feeds');
  assert.throws(() => elevatedArguments([{ ...op, key: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run' }], WIN), /unexpected/, 'another key');
  assert.throws(() => elevatedArguments([{ ...op, name: 'Evil' }], WIN), /unexpected/, 'another value name');
});

test('the quotes of the fixed JSON reach reg.exe as one intact argument through cmd.exe', { skip: process.platform !== 'win32' }, () => {
  // A stand-in System32\reg.exe (a copy of node.exe) records its arguments; "add" and "query" are scripts in its working folder.
  const dir = mkdtempSync(join(tmpdir(), 'kv-ea-'));
  try {
    const sys32 = join(dir, 'System32');
    mkdirSync(sys32);
    try { linkSync(process.execPath, join(sys32, 'reg.exe')); } catch { copyFileSync(process.execPath, join(sys32, 'reg.exe')); }
    const out = join(dir, 'out.json');
    writeFileSync(join(dir, 'add.js'), "require('fs').appendFileSync(process.env.KV_OUT, JSON.stringify(process.argv.slice(2)) + '\\n');\n");
    writeFileSync(join(dir, 'query.js'), 'process.exit(1);\n');
    const ops = buildChannelOps(both(null), 'beta', true);
    execFileSync(join(process.env.SystemRoot || WIN, 'System32', 'cmd.exe'), [elevatedArguments(ops, dir)], { cwd: dir, env: { ...process.env, KV_OUT: out }, windowsVerbatimArguments: true });
    const calls = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.length, ops.length);
    const settings = calls.filter((c) => c.includes('ExtensionSettings'));
    assert.equal(settings.length, 2);
    for (const c of settings) assert.equal(c[c.indexOf('/d') + 1], settingsValue(EARLY_ACCESS_FEED));
    for (const c of calls.filter((x) => !x.includes('ExtensionSettings'))) assert.equal(c[c.indexOf('/d') + 1], BETA_VALUE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Registry stand-in: what runChannelSetup reads, and what the "elevated" call may change. */
// trees: further `reg query <key> /s` output by key (HKCU bases, or the HKLM base in place of the one built from the model);
// marks: `reg query <key> /v <value>` output by "key value" (cloud management).
function fakeSystem({ elevateResult = true, apply, flag = false, settings = {}, lists = {}, trees = {}, marks = {} } = {}) {
  const model = { edge: lists.edge ?? [], chrome: lists.chrome ?? [], settingsEdge: settings.edge ?? null, settingsChrome: settings.chrome ?? null, flag, calls: 0 };
  const hklmTree = (browser) => {
    const base = POLICY_BASES[browser].replace(/^HKLM/, 'HKEY_LOCAL_MACHINE');
    const s = browser === 'edge' ? model.settingsEdge : model.settingsChrome;
    const lines = ['', base, ...(s ? [`    ExtensionSettings    ${s.type}    ${s.value}`] : [])];
    if (model[browser].length) lines.push('', `${base}\\ExtensionInstallForcelist`, ...model[browser].map((e) => `    ${e.name}    REG_SZ    ${e.value}`));
    return s || model[browser].length ? `${lines.join('\r\n')}\r\n` : null;
  };
  // Parent reads of keyAbsent(): keys down to HKLM\SOFTWARE\X always exist, deeper ones only where the model has something.
  const existing = () => [
    ...Object.keys(trees).filter((k) => trees[k] != null),
    ...Object.keys(POLICY_BASES).filter((b) => hklmTree(b) != null).map((b) => POLICY_BASES[b]),
    ...Object.keys(marks).map((m) => m.slice(0, m.lastIndexOf(' '))),
  ];
  const full = (k) => k.replace(/^HKLM/, 'HKEY_LOCAL_MACHINE').replace(/^HKCU/, 'HKEY_CURRENT_USER');
  const listing = (key) => {
    const below = existing().filter((e) => e.toUpperCase().startsWith(`${key.toUpperCase()}\\`));
    if (key.split('\\').length > 3 && !below.length && !existing().some((e) => e.toUpperCase() === key.toUpperCase())) return null;
    const children = [...new Set(below.map((e) => e.slice(0, key.length + 1 + e.slice(key.length + 1).split('\\')[0].length)))];
    return ['', full(key), '', ...children.map(full), ''].join('\r\n');
  };
  return {
    model,
    async regQuery(args) {
      if (args[0] === 'HKLM\\SOFTWARE\\Keevault') return model.flag ? '    NoExtensionPolicy    REG_DWORD    0x1\r\n' : null;
      if (args.length === 1 && !Object.values(POLICY_KEYS).includes(args[0])) return listing(args[0]);
      if (args[1] === '/s') {
        if (args[0] in trees) return trees[args[0]];
        const browser = Object.keys(POLICY_BASES).find((b) => POLICY_BASES[b] === args[0]);
        return browser ? hklmTree(browser) : null;
      }
      if (args[1] === '/v' && !Object.values(POLICY_BASES).includes(args[0])) return marks[`${args[0]} ${args[2]}`] ?? null;
      if (args[1] === '/v') {
        const v = args[0] === POLICY_BASES.edge ? model.settingsEdge : model.settingsChrome;
        return v == null ? null : `    ExtensionSettings    ${v.type}    ${v.value}\r\n`;
      }
      const key = args[0] === POLICY_KEYS.edge ? 'edge' : 'chrome';
      return model[key].length ? model[key].map((e) => `    ${e.name}    REG_SZ    ${e.value}`).join('\r\n') : null;
    },
    async elevate() { model.calls++; if (apply) apply(model); return elevateResult; },
  };
}
const applyBeta = (m) => {
  m.edge = [entry(BETA_VALUE)]; m.chrome = [entry(BETA_VALUE)];
  m.settingsEdge = raw(settingsValue(EARLY_ACCESS_FEED)); m.settingsChrome = raw(settingsValue(EARLY_ACCESS_FEED));
};

test('run: success only when the registry shows the new feed afterwards; declined and silent prompts are told apart', async () => {
  const ours = { lists: { edge: [entry(STABLE_VALUE)], chrome: [entry(STABLE_VALUE)] }, settings: { edge: raw(settingsValue(UPDATE_URL)), chrome: raw(settingsValue(UPDATE_URL)) } };
  const good = fakeSystem({ ...ours, apply: applyBeta });
  assert.deepEqual(await runChannelSetup(good, WIN, { channel: 'beta' }), { result: 'changed', company: false });
  assert.equal(good.model.calls, 1);
  assert.equal((await runChannelSetup(good, WIN, { channel: 'beta' })).result, 'aligned');
  assert.equal(good.model.calls, 1, 'nothing to do: no prompt');
  assert.equal((await runChannelSetup(fakeSystem({ ...ours, elevateResult: false }), WIN, { channel: 'beta' })).result, 'declined');
  assert.equal((await runChannelSetup(fakeSystem({ ...ours }), WIN, { channel: 'beta' })).result, 'failed', 'ran but wrote nothing');
  assert.equal((await runChannelSetup(fakeSystem({ ...ours }), null, { channel: 'beta' })).result, 'unavailable', 'no trusted Windows folder: nothing runs');
});

test('run: company policy, waiver and "nothing of ours" never start the elevated part', async () => {
  const never = (opts) => fakeSystem({ ...opts, apply: () => { throw new Error('must not run'); } });
  const companyList = [entry(`${EXTENSION_ID};https://updates.example.com/crx.xml`)];
  const foreign = raw(JSON.stringify({ [FOREIGN_EXT]: { installation_mode: 'blocked' } }));
  for (const opts of [
    { lists: { edge: companyList, chrome: companyList } },
    { lists: { edge: [entry(STABLE_VALUE)], chrome: [entry(STABLE_VALUE)] }, settings: { edge: foreign, chrome: foreign } },
    { flag: true },
    { flag: true, lists: { edge: [entry(STABLE_VALUE)], chrome: [entry(STABLE_VALUE)] } },
  ]) {
    for (const create of [false, true]) {
      const sys = never(opts);
      assert.equal((await runChannelSetup(sys, WIN, { channel: 'beta', create })).result, 'company', JSON.stringify(opts));
      assert.equal(sys.model.calls, 0);
    }
  }
  const empty = never({});
  assert.equal((await runChannelSetup(empty, WIN, { channel: 'beta', create: false })).result, 'none');
  assert.equal(empty.model.calls, 0);
  const waived = await readPolicies(never({ flag: true }));
  assert.equal(waived.edge.state, 'company', 'the hint offers no fix where the IT waived the policy');
});

// #455 (Konrad): company policies outside our two HKLM entries. An HKLM Forcelist or ExtensionSettings of ours would win
// over them (blocklists and forced security extensions of the company would no longer apply), so nothing may be created.
const HKLM_FULL = (b) => POLICY_BASES[b].replace(/^HKLM/, 'HKEY_LOCAL_MACHINE');
const HKCU_FULL = (b) => USER_POLICY_BASES[b].replace(/^HKCU/, 'HKEY_CURRENT_USER');
const companyCases = {
  'policy only per user (HKCU)': {
    trees: {
      [USER_POLICY_BASES.edge]: `\r\n${HKCU_FULL('edge')}\r\n    BlockExternalExtensions    REG_DWORD    0x1\r\n`,
      [USER_POLICY_BASES.chrome]: `\r\n${HKCU_FULL('chrome')}\r\n\r\n${HKCU_FULL('chrome')}\\ExtensionInstallBlocklist\r\n    1    REG_SZ    *\r\n`,
    },
  },
  'ExtensionSettings as a subkey': {
    trees: Object.fromEntries(['edge', 'chrome'].map((b) => [POLICY_BASES[b],
      `\r\n${HKLM_FULL(b)}\r\n\r\n${HKLM_FULL(b)}\\ExtensionSettings\r\n\r\n${HKLM_FULL(b)}\\ExtensionSettings\\*\r\n    installation_mode    REG_SZ    blocked\r\n`])),
  },
  // #494: a Forcelist entry of another extension no longer counts (test/ext-reinstall-494.test.js); a block list in HKLM does.
  'extension block list in HKLM': {
    trees: Object.fromEntries(['edge', 'chrome'].map((b) => [POLICY_BASES[b], `\r\n${HKLM_FULL(b)}\r\n\r\n${HKLM_FULL(b)}\\ExtensionInstallBlocklist\r\n    1    REG_SZ    *\r\n`])),
  },
  'cloud enrollment token': {
    trees: { [POLICY_BASES.edge]: `\r\n${HKLM_FULL('edge')}\r\n    EdgeManagementEnrollmentToken    REG_SZ    00000000-token\r\n` },
    marks: { 'HKLM\\SOFTWARE\\Policies\\Google\\Update CloudManagementEnrollmentToken': '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Update\r\n    CloudManagementEnrollmentToken    REG_SZ    00000000-token\r\n' },
  },
};

test('company policies outside our two HKLM entries make it "company": nothing created, no elevated start (#455)', async () => {
  for (const [name, opts] of Object.entries(companyCases)) {
    const sys = fakeSystem({ ...opts, apply: () => { throw new Error('must not run'); } });
    const state = await readPolicyState(sys);
    for (const create of [false, true]) {
      assert.deepEqual(buildChannelOps(state, 'beta', create), [], `${name}: no operation (create ${create})`);
      assert.equal((await runChannelSetup(sys, WIN, { channel: 'beta', create })).result, 'company', name);
    }
    assert.equal(sys.model.calls, 0, `${name}: no UAC prompt`);
    const p = await readPolicies(sys);
    for (const b of ['edge', 'chrome']) {
      assert.equal(p[b].state, 'company', `${name}: ${b}`);
      assert.ok(!canFix(p[b], b, 'beta') && !canFix(p[b], b, 'stable'), `${name}: no "Fix now" in ${b}`);
    }
  }
  // every cloud mark of Chrome on its own
  for (const [key, value] of CLOUD_MARKS.chrome) {
    const p = await readPolicies(fakeSystem({ marks: { [`${key} ${value}`]: `    ${value}    REG_SZ    x\r\n` } }));
    assert.equal(p.chrome.state, 'company', key);
    assert.equal(p.edge.state, 'none', 'only Chrome is enrolled');
  }
});

test('our own entries are not foreign; with a company policy beside them only they are switched, nothing added (#455)', async () => {
  const ours = { lists: { edge: [entry(STABLE_VALUE)], chrome: [entry(STABLE_VALUE)] }, settings: { edge: raw(settingsValue(UPDATE_URL)), chrome: raw(settingsValue(UPDATE_URL)) } };
  const plain = await readPolicyState(fakeSystem(ours));
  assert.deepEqual(plain.foreign, { edge: false, chrome: false }, 'our Forcelist entry and ExtensionSettings value');
  assert.equal(foreignInTree(`\r\n${HKCU_FULL('edge')}\r\n`, USER_POLICY_BASES.edge, false), false, 'an empty key per user');
  assert.equal(foreignInTree(null, POLICY_BASES.edge, true), false, 'no key at all');
  assert.equal(foreignInTree(`\r\n${HKLM_FULL('edge')}\r\n    ExtensionSettings    REG_SZ    {}\r\n    HomepageLocation    REG_SZ    https://intranet.example\r\n`, POLICY_BASES.edge, true), false, '#494: an unrelated value next to ours');
  assert.deepEqual(parseRegTree(`\r\n${HKLM_FULL('edge')}\r\n    A B    REG_SZ    \r\n`), [{ key: HKLM_FULL('edge'), values: [{ name: 'A B', type: 'REG_SZ', value: '' }] }]);

  // Forcelist of ours but no ExtensionSettings, and a company policy per user: switch our entry, never add ExtensionSettings.
  const managed = { lists: ours.lists, trees: companyCases['policy only per user (HKCU)'].trees };
  const state = await readPolicyState(fakeSystem(managed));
  for (const create of [false, true]) {
    const ops = buildChannelOps(state, 'beta', create);
    assert.deepEqual(ops.map((o) => o.kind), ['policy-replace', 'policy-replace'], `create ${create}`);
  }
  const p = await readPolicies(fakeSystem(managed));
  assert.ok(p.edge.managed && p.edge.state === 'ours');
  assert.ok(canFix(p.edge, 'edge', 'beta'), 'our entry points to Stable: switching it stays possible');
  assert.ok(!canFix(p.edge, 'edge', 'stable'), 'already on the channel: only adding would be left, so no button');
  const sys = fakeSystem({ ...managed, apply: (m) => { m.edge = [entry(BETA_VALUE)]; m.chrome = [entry(BETA_VALUE)]; } });
  assert.deepEqual(await runChannelSetup(sys, WIN, { channel: 'beta', create: true }), { result: 'changed', company: true });
});

test('the app starts no script from the installation folder for the channel switch either', () => {
  for (const file of ['../desktop/main/extension-channel.js', '../desktop/windows-provider.js', '../desktop/machine-setup.js']) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/setup\.ps1|ExecutionPolicy/i.test(code), file);
  }
  assert.ok(!read('../installer/setup.ps1').includes("'Channel'"), 'no channel action in the script');
  assert.match(read('../desktop/main/extension-channel.js'), /from '\.\.\/machine-setup\.js'/);
});
