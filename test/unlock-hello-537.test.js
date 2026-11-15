import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UnlockService } from '../desktop/unlock-service.js';
import { HelloUnlock } from '../desktop/unlock-hello.js';
import { SimulatedHello } from '../desktop/hello-sim.js';
import { PinGuard, inPinQueue } from '../desktop/pin.js';
import * as U from '../desktop/unlock-keys.js';

// #537 stage 3: Windows Hello unwraps the device key – with the simulated Hello key (desktop/hello-sim.js), never a real
// Windows dialog. Konrad's conditions each have a counter-test here.

const MP = 'correct horse battery';

async function harness({ mode = 'sign', allowed = true } = {}) {
  let settings = { appPin: null, unlockKeys: null, personalDeviceKeys: {}, pinGuard: null, offlineMirror: false };
  const config = { get: () => settings, update: (patch) => { settings = { ...settings, ...patch }; return settings; } };
  const dpapi = { available: async () => true, protect: async (text) => Buffer.from(`D:${text}`).toString('base64'), unprotect: async (b) => Buffer.from(b, 'base64').toString().slice(2) };
  const mirror = { wanted: () => false, unlockFactor: async () => {}, switchFactor: async () => {}, remove: async () => {} };
  const unlocked = [];
  const logs = [];
  const h = { mode, allowed, stale: [] };
  const sim = new SimulatedHello(() => h.mode);
  const svc = new UnlockService({
    config, dpapi, guard: new PinGuard(), queue: inPinQueue, mirror, diag: (x) => logs.push(x), removeHelloKey: (n) => sim.remove(n),
    personal: { entries: () => [], binding: async () => '', unlockWithDk: async (dk) => { unlocked.push(dk); return { stale: h.stale }; } },
  });
  const attestations = [];
  const hello = new HelloUnlock({
    service: svc,
    hello: {
      status: () => sim.status(), create: (n, c) => sim.create(n, c), sign: (n, c) => sim.sign(n, c), remove: (n) => sim.remove(n),
      attested: (a) => { attestations.push(a); return a?.status === 0; }, allowed: () => h.allowed,
    },
  });
  await svc.migrate({ password: MP });
  return Object.assign(h, { svc, hello, sim, unlocked, logs, attestations, settings: () => settings });
}

test('#537 stage 3: Hello on only with the MP; then it unlocks like the MP, one dialog per use', async () => {
  const h = await harness();
  await assert.rejects(h.hello.enable('wrong password!!'), { name: 'WrongSecret' }, 'never without the MP');
  assert.equal(h.sim.asked, 0, 'a wrong MP shows no Hello dialog');
  assert.ok(await h.hello.enable(MP));
  assert.equal(h.attestations.length, 1, 'the attestation was checked');
  assert.equal(h.settings().unlockKeys.hello, true);
  assert.deepEqual(await h.hello.info(), { on: true, allowed: true, available: true, remote: false });
  const before = h.sim.asked;
  assert.ok(await h.hello.unlock());
  assert.ok(await h.hello.unlock());
  assert.equal(h.sim.asked - before, 2, 'one Hello confirmation per use');
  assert.equal(h.unlocked.length, 2);
  const dk = h.svc.recentDk();
  assert.ok(dk && (await U.openWithPassword(await h.svc.readRecord(), MP)).equals(dk), 'Hello opens the same DK as the MP');
});

test('#537 stage 3 (Konrad): no Hello without TPM attestation or with a non-PKCS#1 v1.5 signature – the key is deleted again', async () => {
  for (const mode of ['noattest', 'random']) {
    const h = await harness({ mode });
    await assert.rejects(h.hello.enable(MP), { name: mode === 'noattest' ? 'HelloNoTpm' : 'HelloSignature' });
    assert.equal(h.settings().unlockKeys.hello, false, mode);
    assert.equal(h.sim.keys.size, 0, `${mode}: the created key is gone again`);
  }
});

test('#537 stage 3: cancel counts nothing; reset or a lost key drops the wrapper and asks the MP', async () => {
  const h = await harness();
  await h.hello.enable(MP);
  h.mode = 'cancel';
  await assert.rejects(h.hello.unlock(), { name: 'HelloCanceled' });
  assert.equal(h.svc.guard.waitSeconds(), 0);
  assert.equal(h.settings().unlockKeys.hello, true, 'a cancel keeps Hello');
  h.mode = 'unavailable';
  await assert.rejects(h.hello.unlock(), { name: 'HelloUnavailable' });
  h.mode = 'remote';
  await assert.rejects(h.hello.unlock(), { name: 'HelloUnavailable' }, 'no Hello over remote desktop');
  h.mode = 'reset';
  await assert.rejects(h.hello.unlock(), { name: 'HelloReset' });
  assert.equal(h.settings().unlockKeys.hello, false, 'the wrapper went');
  assert.equal(h.unlocked.length, 0, 'nothing opened');
  assert.ok(await h.svc.verifyUnlock(MP), 'the MP still opens');
  h.mode = 'sign';
  await h.hello.enable(MP);
  h.mode = 'gone';
  await assert.rejects(h.hello.unlock(), { name: 'HelloReset' });
  assert.equal(h.settings().unlockKeys.hello, false);
});

test('#537 stage 3: off and the organization’s ban – off needs the MP, the ban removes Hello at start', async () => {
  const h = await harness();
  await h.hello.enable(MP);
  await assert.rejects(h.hello.disable('wrong password!!'), { name: 'WrongSecret' });
  assert.equal(h.settings().unlockKeys.hello, true);
  assert.ok(await h.hello.disable(MP));
  assert.equal(h.settings().unlockKeys.hello, false);
  assert.equal(h.sim.keys.size, 0, 'the key in the Hello container is deleted');
  await h.hello.enable(MP);
  h.allowed = false;
  await h.hello.enforcePolicy();
  assert.equal(h.settings().unlockKeys.hello, false);
  await assert.rejects(h.hello.enable(MP), { name: 'HelloForbidden' });
  await assert.rejects(h.hello.unlock(), { name: 'HelloOff' });
});

test('#537 stage 3: one Hello request at a time; a new MP ends Hello; nothing of Hello is logged or kept', async () => {
  const h = await harness();
  await h.hello.enable(MP);
  const [a, b] = await Promise.allSettled([h.hello.proveDk(), h.hello.proveDk()]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.reason?.name, 'HelloBusy');
  const record = await h.svc.readRecord();
  assert.ok(!('signature' in record.hello), 'no signature stored');
  assert.ok(h.logs.every((l) => !/[A-Za-z0-9+/]{40,}/.test(l)), 'no key material in the log');
  assert.equal(h.sim.keys.size, 1);
  await h.svc.rotate('a completely new password');
  assert.equal(h.settings().unlockKeys.hello, false, 'a new MP (new DK) drops the Hello wrapper');
  assert.equal(h.sim.keys.size, 0, 'Konrad (review 5d81351): the old key goes from the Hello container');
  await assert.rejects(h.hello.unlock(), { name: 'HelloOff' });
});

test('#537 stage 3: wiring – the simulation only in smoke runs, the attestation checked in the main process', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const main = read('desktop/main/hello-key.js');
  assert.match(main, /const simulation = smokeTest && !!demo;/, 'Konrad: the simulation only in the demo smoke run');
  assert.match(main, /simulation \? new SimulatedHello\(\)/);
  assert.match(main, /const CREATE_MS = 8 \* 60_000;/, 'longer than the helper (3 + 3 + 1 min)');
  assert.match(main, /verifyAttestation\(/);
});

test('#537 (Konrad, review 5d81351): a key made although the answer failed is deleted again', async () => {
  const h = await harness();
  let made = null;
  h.hello.hello.create = async (name) => { made = name; h.sim.keys.set(name, 'late'); return null; }; // timeout: no answer
  await assert.rejects(h.hello.enable(MP), { name: 'HelloUnavailable' });
  assert.ok(made && !h.sim.keys.has(made), 'the late key is removed');
});
