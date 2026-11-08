import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import {
  parseRegQuery, classifyForcelist, buildOps, elevatedArguments, windowsFolder, certBlobHex, runMachineSetup, readState, pinnedFingerprint,
  POLICY_VALUE, EXTENSION_ID, POLICY_KEYS, NO_POLICY_KEY, NO_POLICY_VALUE, POLICY_BASES, USER_POLICY_BASES, machineSetupStatus,
} from '../desktop/machine-setup.js';

// #395: the elevated part of the in-app setup runs only fixed system programs, never overwrites foreign policy entries,
// and counts as done only when the registry shows it.

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const entry = (name, value) => ({ name, value });
const OLD = `${EXTENSION_ID};https://github.com/dominguez-posh/keyvault-pwsafe-releases/releases/download/v0.5/update.xml`;
const FOREIGN = `${EXTENSION_ID};https://intranet.example/update.xml`;
const WIN = 'C:\\Windows';
const der = Buffer.from('3082000a'.repeat(20), 'hex');
const cert = (trusted, pinned = true) => ({ der, thumbprint: 'AB'.repeat(20), trusted, pinned });

test('reg query output is parsed into entries', () => {
  const out = `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist\r\n    1    REG_SZ    a;b\r\n    3    REG_SZ    c;d\r\n\r\n`;
  assert.deepEqual(parseRegQuery(out), [entry('1', 'a;b'), entry('3', 'c;d')]);
});

test('forcelist: foreign entry with our ID is left alone, own old one is replaced, free number is taken', () => {
  assert.equal(classifyForcelist([entry('1', FOREIGN)]).state, 'theirs');
  assert.equal(classifyForcelist([entry('1', OLD)]).state, 'own-old');
  assert.equal(classifyForcelist([entry('1', POLICY_VALUE)]).state, 'current');
  assert.deepEqual(classifyForcelist([entry('1', 'x;y'), entry('2', 'z;w')]), { state: 'missing', free: '3' });
  assert.deepEqual(classifyForcelist(null), { state: 'missing', free: '1' });
});

test('plan: nothing for what is in place, foreign, or switched off (KV_NO_POLICY)', () => {
  const both = (list) => ({ edge: list, chrome: list });
  assert.deepEqual(buildOps({ cert: cert(true), policies: both([entry('1', POLICY_VALUE)]) }), []);
  assert.deepEqual(buildOps({ cert: cert(true), policies: both([entry('1', FOREIGN)]) }), []);
  assert.deepEqual(buildOps({ cert: cert(true), policyBlocked: true, policies: both(null) }), []);
  const ops = buildOps({ cert: cert(false), policies: both([entry('1', 'other;x')]) });
  assert.deepEqual(ops.map((o) => o.kind), ['cert', 'policy-add', 'policy-add']);
  assert.equal(ops[1].name, '2');
  assert.equal(buildOps({ cert: cert(false), policyBlocked: true, policies: both(null) }).length, 1);
  assert.equal(buildOps({ cert: cert(true), policies: { edge: [entry('1', OLD)], chrome: [entry('1', POLICY_VALUE)] } })[0].kind, 'policy-replace');
});

test('certificate blob: property 32, flag 1, length, certificate', () => {
  const hex = certBlobHex(Buffer.from([1, 2, 3]));
  assert.equal(hex, '200000000100000003000000010203');
});

test('elevated command line: only reg.exe from the Windows folder, no script, no PowerShell, no foreign overwrite', () => {
  const ops = buildOps({ cert: cert(false), policies: { edge: [entry('1', FOREIGN.replace(EXTENSION_ID, 'zzz'))], chrome: null } });
  const args = elevatedArguments(ops, 'C:\\Windows');
  assert.match(args, /^\/d \/s \/c "/);
  assert.ok(!/setup\.ps1|powershell|ExecutionPolicy|Bypass/i.test(args));
  const programs = [...args.matchAll(/"([^"]+\.exe)"/g)].map((m) => m[1].toLowerCase());
  assert.ok(programs.length >= 3 && programs.every((p) => p === 'c:\\windows\\system32\\reg.exe'));
  // a new policy value is only written where the name is still free
  assert.match(args, /query "HKLM[^"]*Edge[^"]*" \/v 2 >nul 2>&1 \|\| /);
  assert.ok(args.includes(POLICY_KEYS.chrome));
});

test('elevated command line: nothing that could break out of cmd.exe', () => {
  assert.throws(() => elevatedArguments([{ kind: 'policy-add', key: POLICY_KEYS.edge, name: '1', value: 'a" & calc & "' }]));
  assert.throws(() => elevatedArguments([{ kind: 'policy-add', key: POLICY_KEYS.edge, name: '1&calc', value: 'x' }]));
});

test('the Windows folder is C:\Windows or nothing runs elevated (#395)', async () => {
  assert.equal(windowsFolder({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows');
  assert.equal(windowsFolder({ SystemRoot: 'D:\\Windows' }), null, 'another drive: a foreign reg.exe');
  assert.equal(windowsFolder({ SystemRoot: 'C:\\Users\\x\\AppData\\evil' }), null);
  assert.equal(windowsFolder({}), null);
  assert.throws(() => elevatedArguments([], null));
  const sys = { async regQuery() { throw new Error('not read'); }, async certTrusted() { return false; }, async elevate() { throw new Error('must not start'); } };
  const dir = mkdtempSync(join(tmpdir(), 'kv-ms-'));
  try {
    const file = join(dir, 'c.cer');
    writeFileSync(file, readFileSync(new URL('./fixtures/test-cert.crt', import.meta.url)));
    const sysOk = { async regQuery() { return null; }, async certTrusted() { return false; }, async elevate() { throw new Error('must not start'); } };
    const r = await runMachineSetup(sysOk, file, null, pinOf(file));
    assert.equal(r.ok, false);
    assert.ok(r.remaining.includes('cert'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  void sys;
});

const pinOf = (file) => createHash('sha256').update(new X509Certificate(readFileSync(file)).raw).digest('hex');

test('only the certificate pinned at build time reaches the trust store (#395)', async () => {
  assert.equal(buildOps({ cert: cert(false, false), policyBlocked: true, policies: {} }).length, 0, 'not pinned: no cert operation');
  assert.equal(buildOps({ cert: cert(false, true), policyBlocked: true, policies: {} }).length, 1);
  const dir = mkdtempSync(join(tmpdir(), 'kv-ms-'));
  try {
    const file = join(dir, 'c.cer');
    writeFileSync(file, readFileSync(new URL('./fixtures/test-cert.crt', import.meta.url)));
    const sys = { async regQuery() { return null; }, async certTrusted() { return false; } };
    assert.equal((await readState(sys, file, pinOf(file))).cert.pinned, true);
    assert.equal((await readState(sys, file, '')).cert.pinned, false, 'no pin (e.g. a run from source)');
    assert.equal((await readState(sys, file, 'ab'.repeat(32))).cert.pinned, false, 'swapped certificate');
    assert.equal((await readState(sys, file, pinOf(file).toUpperCase())).cert.pinned, false, 'only the exact lower-case form');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(pinnedFingerprint(), /^([0-9a-f]{64})?$/);
});

// Fake system: a registry model that the "elevated" call may or may not change.
function fakeSystem({ elevateResult, apply }) {
  const model = { trusted: false, edge: [], chrome: [], flag: null, calls: 0 };
  return {
    model,
    async regQuery(args) {
      if (args[1] === '/v') return model.flag && args[0] === NO_POLICY_KEY ? '    NoExtensionPolicy    REG_DWORD    0x1\r\n' : null;
      // any other key (parent reads, cloud marks; #455): there, without values or subkeys
      if (args.length === 1 && !Object.values(POLICY_KEYS).includes(args[0])) return `\r\n${args[0].replace(/^HKLM/, 'HKEY_LOCAL_MACHINE').replace(/^HKCU/, 'HKEY_CURRENT_USER')}\r\n`;
      const key = args[0] === POLICY_KEYS.edge ? 'edge' : 'chrome';
      return model[key].map((e) => `    ${e.name}    REG_SZ    ${e.value}`).join('\r\n');
    },
    async certTrusted() { return model.trusted; },
    async elevate() { model.calls++; if (apply) apply(model); return elevateResult; },
  };
}
test('run: declined prompt reports no success and changes nothing; success is judged by re-reading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-ms-'));
  try {
    const pem = readFileSync(new URL('./fixtures/test-cert.crt', import.meta.url), 'utf8');
    const file = join(dir, 'c.cer');
    writeFileSync(file, pem);
    const declined = fakeSystem({ elevateResult: false });
    let r = await runMachineSetup(declined, file, WIN, pinOf(file));
    assert.equal(r.ok, false);
    assert.equal(r.declined, true);
    // elevated part "ran" (exit code 0) but wrote nothing: still no success
    const silent = fakeSystem({ elevateResult: true });
    r = await runMachineSetup(silent, file, WIN, pinOf(file));
    assert.equal(r.ok, false);
    assert.equal(r.declined, false);
    // it wrote everything
    const good = fakeSystem({ elevateResult: true, apply: (m) => { m.trusted = true; m.edge.push(entry('1', POLICY_VALUE)); m.chrome.push(entry('1', POLICY_VALUE)); } });
    r = await runMachineSetup(good, file, WIN, pinOf(file));
    assert.equal(r.ok, true);
    assert.equal(good.model.calls, 1);
    // nothing to do: no prompt at all
    r = await runMachineSetup(good, file, WIN, pinOf(file));
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
    assert.equal(good.model.calls, 1);
    // KV_NO_POLICY remembered: no policy step, certificate only
    const off = fakeSystem({ elevateResult: true, apply: (m) => { m.trusted = true; } });
    off.model.flag = true;
    r = await runMachineSetup(off, file, WIN, pinOf(file));
    assert.equal(r.ok, true);
    assert.deepEqual(off.model.edge, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #455 on #395: the device setup uses the same detection as the channel switch. A company policy per user, in subkeys,
// for other extensions or from the cloud: no Forcelist of ours is created (it would push the company's list aside).
function treeSystem({ lists = {}, trees = {}, marks = {}, apply } = {}) {
  const model = { edge: lists.edge ?? [], chrome: lists.chrome ?? [], calls: 0 };
  const full = (k) => k.replace(/^HKLM/, 'HKEY_LOCAL_MACHINE').replace(/^HKCU/, 'HKEY_CURRENT_USER');
  return {
    model,
    async regQuery(args) {
      if (args[0] === NO_POLICY_KEY) return null;
      if (args[1] === '/s') {
        if (args[0] in trees) return trees[args[0]];
        const b = Object.keys(POLICY_BASES).find((x) => POLICY_BASES[x] === args[0]);
        if (!b || !model[b].length) return null;
        return `\r\n${full(args[0])}\r\n\r\n${full(POLICY_KEYS[b])}\r\n${model[b].map((e) => `    ${e.name}    REG_SZ    ${e.value}`).join('\r\n')}\r\n`;
      }
      if (args[1] === '/v') return marks[`${args[0]} ${args[2]}`] ?? null;
      // any other key (parent reads, cloud marks; #455): there, without values or subkeys, so a missing base is absent
      if (!Object.values(POLICY_KEYS).includes(args[0])) return `\r\n${full(args[0])}\r\n`;
      const b = args[0] === POLICY_KEYS.edge ? 'edge' : 'chrome';
      return model[b].length ? model[b].map((e) => `    ${e.name}    REG_SZ    ${e.value}`).join('\r\n') : null;
    },
    async certTrusted() { return true; },
    async elevate() { model.calls++; if (apply) apply(model); return true; },
  };
}
const NO_CERT = join(tmpdir(), 'kv-no-such-cert.cer');
const userTrees = {
  [USER_POLICY_BASES.edge]: '\r\nHKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\\Edge\r\n    BlockExternalExtensions    REG_DWORD    0x1\r\n',
  [USER_POLICY_BASES.chrome]: '\r\nHKEY_CURRENT_USER\\SOFTWARE\\Policies\\Google\\Chrome\r\n\r\nHKEY_CURRENT_USER\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallBlocklist\r\n    1    REG_SZ    *\r\n',
};
const subkeyTree = (b) => {
  const base = POLICY_BASES[b].replace(/^HKLM/, 'HKEY_LOCAL_MACHINE');
  return `\r\n${base}\r\n\r\n${base}\\ExtensionSettings\r\n\r\n${base}\\ExtensionSettings\\*\r\n    installation_mode    REG_SZ    blocked\r\n`;
};
const deviceCompanyCases = {
  'policy only per user (HKCU)': { trees: userTrees },
  'ExtensionSettings as a subkey': { trees: { [POLICY_BASES.edge]: subkeyTree('edge'), [POLICY_BASES.chrome]: subkeyTree('chrome') } },
  'Forcelist entry of another extension': { lists: { edge: [entry('1', 'abcdefghijklmnopabcdefghijklmnop;https://x.example/u.xml')], chrome: [entry('1', 'abcdefghijklmnopabcdefghijklmnop;https://x.example/u.xml')] } },
  'cloud enrollment token': {
    trees: { [POLICY_BASES.edge]: '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge\r\n    EdgeManagementEnrollmentToken    REG_SZ    t\r\n' },
    marks: { 'HKLM\\SOFTWARE\\Policies\\Google\\Update CloudManagementEnrollmentToken': '    CloudManagementEnrollmentToken    REG_SZ    t\r\n' },
  },
};

test('device setup: a company policy outside our entries means no Forcelist is created and no prompt (#455)', async () => {
  for (const [name, opts] of Object.entries(deviceCompanyCases)) {
    const sys = treeSystem({ ...opts, apply: () => { throw new Error('must not run'); } });
    assert.deepEqual(buildOps(await readState(sys, NO_CERT, '')), [], name);
    const r = await runMachineSetup(sys, NO_CERT, WIN, '');
    assert.equal(r.changed, false, name);
    assert.deepEqual(r.company, ['edge', 'chrome'], `${name}: the result names the company's browsers`);
    assert.equal(sys.model.calls, 0, `${name}: no UAC prompt`);
    const s = await machineSetupStatus(sys, NO_CERT, '');
    assert.ok(s.edgeCompany && s.chromeCompany && !s.canRunSetup, `${name}: status ${JSON.stringify(s)}`);
  }
  // without anything foreign the setup still creates our entries
  const plain = treeSystem();
  assert.deepEqual(buildOps(await readState(plain, NO_CERT, '')).map((o) => o.kind), ['policy-add', 'policy-add']);
  const s = await machineSetupStatus(plain, NO_CERT, '');
  assert.ok(!s.edgeCompany && !s.chromeCompany);
  // an old entry of ours next to a company policy per user may still be replaced, nothing is added
  const managed = treeSystem({ lists: { edge: [entry('1', OLD)], chrome: [] }, trees: userTrees });
  assert.deepEqual(buildOps(await readState(managed, NO_CERT, '')).map((o) => [o.kind, o.key]), [['policy-replace', POLICY_KEYS.edge]]);
});

test('the app no longer starts a script from the installation folder elevated', () => {
  const src = read('../desktop/windows-provider.js') + read('../desktop/machine-setup.js');
  assert.ok(!/setup\.ps1|ExecutionPolicy|-Verb RunAs[^`]*-File/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
});

test('setup.ps1: parses, remembers KV_NO_POLICY, leaves foreign entries and trusted certificates alone', { skip: process.platform !== 'win32' }, () => {
  const file = fileUrl('../installer/setup.ps1');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$e); $e.Count`], { encoding: 'utf8' });
  assert.equal(out.trim(), '0');
  const ps = read('../installer/setup.ps1');
  assert.match(ps, /NoExtensionPolicy/);
  assert.match(ps, /-like "\$ExtensionId;\$OwnSource\*"/);
  assert.match(ps, /\$have\b/);
});

test('the docs name the remembered KV_NO_POLICY value with its real registry path', { skip: !existsSync(new URL('../website/kb/it-verteilung.md', import.meta.url)) }, () => {
  const full = `${NO_POLICY_KEY}\\${NO_POLICY_VALUE}`;
  for (const doc of ['../website/kb/it-verteilung.md', '../docs/ENTSCHEIDUNGEN.md']) {
    const text = read(doc);
    assert.ok(text.includes(full), `${doc} misses ${full}`);
    assert.ok(!text.includes('HKLMSOFTWARE'), `${doc} has a path without backslashes`);
  }
});

function fileUrl(p) {
  return decodeURIComponent(new URL(p, import.meta.url).pathname).replace(/^\//, '').replace(/\//g, '\\');
}
