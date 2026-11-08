import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  system, REG_QUERY_OPTIONS, CLOUD_MARKS, readPolicies, runChannelSetup, runMachineSetup, keyAbsent,
} from '../desktop/machine-setup.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #455 (Konrad): reg.exe fails alike for a missing key, a denied read, a timeout and an oversized answer. Only a key that
// is provably missing counts as "nothing there"; every other failed read makes the browser the company's, nothing is written.
// The stand-in is reg.exe itself (system.run), so the real regQuery with its options is under test.

const WIN = 'C:\\Windows';
const NO_CERT = join(tmpdir(), 'kv-455-no-such-certificate.cer');
const BASE_KEYS = [
  'HKLM\\SOFTWARE', 'HKLM\\SOFTWARE\\Policies', 'HKLM\\SOFTWARE\\Policies\\Microsoft', 'HKLM\\SOFTWARE\\Policies\\Google',
  'HKLM\\SOFTWARE\\Google', 'HKLM\\SOFTWARE\\Microsoft', 'HKLM\\SOFTWARE\\WOW6432Node', 'HKLM\\SOFTWARE\\WOW6432Node\\Google',
  'HKCU\\SOFTWARE', 'HKCU\\SOFTWARE\\Policies',
];
const full = (k) => k.replace(/^HKLM/, 'HKEY_LOCAL_MACHINE').replace(/^HKCU/, 'HKEY_CURRENT_USER');

/** A fake reg.exe: keys: { key: { values: [[name, type, value]], pad } }; fail: { key or "key /s": 'denied' | 'timeout' }. */
function fakeReg({ keys = {}, fail = {} } = {}) {
  const parents = Object.keys(keys).flatMap((k) => k.split('\\').slice(1, -1).map((_, i) => k.split('\\').slice(0, i + 2).join('\\')));
  const all = new Map([...[...BASE_KEYS, ...parents].map((k) => [k, {}]), ...Object.entries(keys)].map(([k, v]) => [k.toUpperCase(), { name: k, ...v }]));
  const calls = { elevate: 0, options: [] };
  const block = (k) => ['', full(k.name), ...(k.values || []).map(([n, t, v]) => `    ${n}    ${t}    ${v}`)];
  const kids = (up) => [...all.keys()].filter((c) => c.startsWith(`${up}\\`) && !c.slice(up.length + 1).includes('\\'));
  const error = (props) => Object.assign(new Error('Command failed: reg.exe'), props);
  const run = async (file, [cmd, key, flag, name], options) => {
    assert.equal(cmd, 'query');
    calls.options.push(options);
    const up = key.toUpperCase();
    const kind = fail[`${key} ${flag}`] || Object.entries(fail).find(([k]) => !k.includes(' ') && (up === k.toUpperCase() || up.startsWith(`${k.toUpperCase()}\\`)))?.[1];
    if (kind === 'denied') throw error({ code: 1, stdout: '', stderr: 'ERROR: Zugriff verweigert' });
    if (kind === 'timeout') throw error({ killed: true, signal: 'SIGTERM', code: null });
    const k = all.get(up);
    if (!k) throw error({ code: 1, stdout: '', stderr: 'ERROR: Schluessel nicht gefunden' });
    let lines;
    if (flag === '/v') {
      const v = (k.values || []).find(([n]) => n.toLowerCase() === name.toLowerCase());
      if (!v) throw error({ code: 1 });
      lines = ['', full(k.name), `    ${v[0]}    ${v[1]}    ${v[2]}`];
    } else if (flag === '/s') {
      lines = [...all.keys()].filter((c) => c === up || c.startsWith(`${up}\\`)).flatMap((c) => block(all.get(c)));
    } else {
      lines = [...block(k), '', ...kids(up).map((c) => full(all.get(c).name))];
    }
    const size = lines.join('\r\n').length + (flag === '/s' ? [...all.keys()].filter((c) => c === up || c.startsWith(`${up}\\`)).reduce((n, c) => n + (all.get(c).pad || 0), 0) : 0);
    if (size > options.maxBuffer) throw error({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    return { stdout: `${lines.join('\r\n')}\r\n`, stderr: '' };
  };
  return { ...system, run, calls, async elevate() { calls.elevate++; return true; }, async certTrusted() { return true; } };
}

test('regQuery: a timeout and a far larger buffer than the default are set (#455)', () => {
  assert.ok(REG_QUERY_OPTIONS.timeout > 0 && REG_QUERY_OPTIONS.timeout <= 60000);
  assert.ok(REG_QUERY_OPTIONS.maxBuffer >= 16 * 1024 * 1024);
  assert.equal(REG_QUERY_OPTIONS.windowsHide, true);
});

test('a missing key is told apart from an unreadable one (#455)', async () => {
  const sys = fakeReg({ keys: { 'HKCU\\SOFTWARE\\Policies\\Microsoft': {}, 'HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge': {} }, fail: { 'HKCU\\SOFTWARE\\Policies\\Microsoft': 'denied' } });
  assert.equal(await keyAbsent(sys, 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome'), true, 'parent readable, key not listed');
  assert.equal(await keyAbsent(sys, 'HKCU\\SOFTWARE\\Policies\\Google\\Chrome'), true, 'parent missing as well');
  assert.equal(await keyAbsent(sys, 'HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge'), false, 'parent unreadable but it exists');
  assert.equal(await keyAbsent(fakeReg({ fail: { HKLM: 'denied' } }), 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome'), false, 'nothing readable');
});

test('control: with nothing there and "create", the setup would write (#455)', async () => {
  const sys = fakeReg();
  const p = await readPolicies(sys);
  assert.equal(p.edge.state, 'none');
  assert.equal(p.chrome.state, 'none');
  assert.equal((await runChannelSetup(sys, WIN, { channel: 'beta', create: true })).result, 'failed', 'the stand-in writes nothing');
  assert.equal(sys.calls.elevate, 1);
  for (const o of sys.calls.options) assert.equal(o, REG_QUERY_OPTIONS);
});

const failing = {
  'access denied on the policy key per user': { browser: 'edge', keys: { 'HKCU\\SOFTWARE\\Policies\\Microsoft': {}, 'HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge': {} }, fail: { 'HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge': 'denied' } },
  'access denied one level up': { browser: 'edge', keys: { 'HKCU\\SOFTWARE\\Policies\\Microsoft': {}, 'HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge': {} }, fail: { 'HKCU\\SOFTWARE\\Policies\\Microsoft': 'denied' } },
  'timeout on the machine policy tree': { browser: 'chrome', keys: { 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome': {} }, fail: { 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome /s': 'timeout' } },
  'oversized machine policy tree': { browser: 'edge', keys: { 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge': { values: [['HomepageLocation', 'REG_SZ', 'x']], pad: 64 * 1024 * 1024 } } },
  'access denied on a cloud mark': { browser: 'chrome', keys: { 'HKLM\\SOFTWARE\\WOW6432Node\\Google\\Enrollment': {} }, fail: { 'HKLM\\SOFTWARE\\WOW6432Node\\Google\\Enrollment': 'denied' } },
};

test('access denied, timeout and an oversized answer make it "company", and nothing is written (#455)', async () => {
  for (const [name, { browser, ...opts }] of Object.entries(failing)) {
    const p = await readPolicies(fakeReg(opts));
    assert.equal(p[browser].state, 'company', name);
    assert.equal(p[browser === 'edge' ? 'chrome' : 'edge'].state, 'none', `${name}: the other browser stays readable`);
    // the other browser could still be set up; with both failing nothing at all may start
    const both = fakeReg({ keys: { ...failing['access denied one level up'].keys, ...failing['timeout on the machine policy tree'].keys, ...opts.keys }, fail: { ...failing['access denied one level up'].fail, ...failing['timeout on the machine policy tree'].fail, ...opts.fail } });
    both.calls.elevate = 0;
    assert.equal((await runChannelSetup(both, WIN, { channel: 'beta', create: true })).result, 'company', `${name}: channel`);
    const machine = await runMachineSetup(both, NO_CERT, WIN, '');
    assert.deepEqual(machine.remaining, [], `${name}: device setup has nothing to do`);
    assert.equal(both.calls.elevate, 0, `${name}: no UAC prompt, no write`);
  }
});

test('every cloud mark is read fail-closed, also those of Edge (#455)', async () => {
  for (const browser of ['edge', 'chrome']) {
    for (const [key, value] of CLOUD_MARKS[browser]) {
      const set = await readPolicies(fakeReg({ keys: { [key]: { values: [[value, 'REG_SZ', 'x']] } } }));
      assert.equal(set[browser].state, 'company', `${key} set`);
      const denied = await readPolicies(fakeReg({ keys: { [key]: {} }, fail: { [key]: 'denied' } }));
      assert.equal(denied[browser].state, 'company', `${key} unreadable`);
      const empty = await readPolicies(fakeReg({ keys: { [key]: { values: [['Other', 'REG_SZ', 'x']] } } }));
      assert.equal(empty[browser].state, 'none', `${key} without the value`);
    }
  }
});
