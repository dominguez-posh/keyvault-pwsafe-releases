import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimJob } from '../desktop/signin-claim.js';

// #424 (Konrad N1): the passkey prompt on a sign-in page must not use the app's one-click job or the account chosen in
// the bar for a tab that may not start a sign-in or that did not start it.

const store = {};
globalThis.chrome = { storage: { session: {
  get: async (key) => (key in store ? { [key]: store[key] } : {}),
  set: async (o) => { Object.assign(store, o); },
} } };
const { signInUser, MS_JOB_MS } = await import('../extension/lib/signin-user.js');

const HOSTS = /(^|\.)(login\.microsoftonline\.com|bastion\.azure\.com)$/i;
const MS = /(^|\.)login\.microsoftonline\.com$/i;
const sender = (tabId) => ({ tab: { id: tabId, url: 'https://login.microsoftonline.com/' }, frameId: 0 });

/** The app side as in desktop/main/signin.js: one job, claimed by the first tab that asks. */
function appWithJob() {
  const job = { username: 'admin@contoso.com' };
  const calls = [];
  return { calls, app: { signIn: async (host, tab) => { calls.push(tab); return claimJob(job, tab) ? { username: job.username } : null; } } };
}
const deps = (app, trusted) => ({
  demo: null, app, signInHosts: HOSTS, msLoginHosts: MS,
  mayStartSignIn: async (s) => trusted.includes(s.tab.id),
  tabKey: async (s) => `b:${s.tab.id}`,
});

test('a tab that may not start a sign-in gets no account of the app\'s job, and does not claim it', async () => {
  const { app, calls } = appWithJob();
  assert.equal(await signInUser('login.microsoftonline.com', sender(9), deps(app, [])), '');
  assert.deepEqual(calls, [], 'the app was asked although the tab is not trusted');
});

test('the job goes to the first trusted tab with its key; a second tab gets nothing', async () => {
  const { app, calls } = appWithJob();
  const d = deps(app, [1, 2]);
  assert.equal(await signInUser('login.microsoftonline.com', sender(1), d), 'admin@contoso.com');
  assert.equal(await signInUser('login.microsoftonline.com', sender(1), d), 'admin@contoso.com');
  assert.equal(await signInUser('login.microsoftonline.com', sender(2), d), '');
  assert.deepEqual(calls, ['b:1', 'b:1', 'b:2']);
});

test('the account chosen in the bar counts only in the tab that chose it', async () => {
  const d = deps({ signIn: async () => null }, []);
  store.msJob = { username: 'chosen@contoso.com', until: Date.now() + MS_JOB_MS, tab: 'b:4' };
  assert.equal(await signInUser('login.microsoftonline.com', sender(4), d), 'chosen@contoso.com');
  assert.equal(await signInUser('login.microsoftonline.com', sender(5), d), '');
  store.msJob = { username: 'old@contoso.com', until: Date.now() + MS_JOB_MS }; // written by an older version: no tab
  assert.equal(await signInUser('login.microsoftonline.com', sender(4), d), '');
});

test('without a tab key a job that a tab already claimed is not handed out (#424)', () => {
  const job = {};
  assert.equal(claimJob(job, 'x:1'), true);
  assert.equal(claimJob(job, undefined), false);
  assert.equal(claimJob(job, null), false);
});
