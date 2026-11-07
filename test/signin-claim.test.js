import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { claimJob } from '../desktop/signin-claim.js';
import { microsoftPage } from '../extension/core/tabtrust.js';

// #372: the app's one-click sign-in goes to one tab; a page that another page opened starts no sign-in by itself.

test('the job belongs to the first tab that asks, a second tab gets nothing', () => {
  const job = { hosts: ['login.microsoftonline.com'] };
  assert.equal(claimJob(job, 'browser-a:12'), true);
  assert.equal(claimJob(job, 'browser-a:12'), true); // the same tab reads it again for every step
  assert.equal(claimJob(job, 'browser-a:13'), false); // another tab of the same browser
  assert.equal(claimJob(job, 'browser-b:12'), false); // same tab number in another browser
  assert.equal(job.tab, 'browser-a:12');
});

test('without a tab key nothing is claimed (older extension)', () => {
  const job = {};
  assert.equal(claimJob(job, undefined), true);
  assert.equal(job.tab, undefined);
  assert.equal(claimJob(job, 'x:1'), true);
});

test('Microsoft pages are an exact list: names others can register are not on it (#372)', () => {
  for (const url of ['https://login.microsoftonline.com/common/oauth2', 'https://portal.azure.com/', 'https://admin.microsoft.com/Adminportal', 'https://entra.microsoft.com/', 'https://bst-1234.bastion.azure.com/#/client'])
    assert.equal(microsoftPage(url), true, url);
  for (const url of [
    'https://evil.cloudapp.azure.com/', 'https://evil.westeurope.cloudapp.azure.com/', 'https://evil.blob.core.windows.net/x.html', 'https://evil.web.core.windows.net/',
    'https://evil.azurewebsites.net/', 'https://evil.example/?x=https://portal.azure.com/', 'https://login.microsoftonline.com.evil.example/', 'http://portal.azure.com/',
    'https://portal.azure.com:8443/', 'https://a.b.bastion.azure.com/', 'https://microsoft.com/', 'about:blank', '', undefined,
  ]) assert.equal(microsoftPage(url), false, String(url));
});

// The browser's events, as the extension receives them, against the real lib/tabs.js.
async function browser(existingTabs = []) {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { (listeners[name] ||= []).push(fn); } });
  const store = {};
  const urls = new Map(existingTabs.map((t) => [t.id, t.url]));
  globalThis.chrome = {
    storage: { session: {
      get: async (key) => (typeof key === 'string' ? (key in store ? { [key]: store[key] } : {}) : { ...store }),
      set: async (o) => { Object.assign(store, o); },
      remove: async (key) => { for (const k of [key].flat()) delete store[k]; },
    } },
    webNavigation: { onCreatedNavigationTarget: on('created'), onBeforeNavigate: on('before'), onCommitted: on('committed'), getFrame: async ({ tabId, frameId }) => ({ url: frameId === 0 ? urls.get(tabId) : urls.get(`${tabId}:${frameId}`) }) },
    runtime: { onInstalled: on('installed'), onStartup: on('startup') },
    tabs: { onRemoved: on('removed'), query: async () => existingTabs, get: async (id) => ({ id, url: urls.get(id) }) },
  };
  const tabs = await import(`../extension/lib/tabs.js?${Math.random()}`);
  tabs.watchTabs();
  const fire = async (name, d) => { for (const fn of listeners[name] || []) fn(d); await new Promise((r) => setImmediate(r)); };
  return {
    mayStart: (tabId, { frameId = 0, tabUrl, auto = false } = {}) => tabs.mayStartSignIn({ tab: { id: tabId, url: tabUrl ?? urls.get(tabId) }, frameId }, { auto }),
    // start: the URL the navigation began with (onBeforeNavigate); a redirect may end elsewhere.
    commit: async (tabId, url, transitionType = 'link', transitionQualifiers = [], start = url) => {
      await fire('before', { tabId, frameId: 0, url: start });
      urls.set(tabId, url);
      await fire('committed', { tabId, frameId: 0, url, transitionType, transitionQualifiers });
    },
    startup: () => fire('startup'),
    opened: (tabId, sourceTabId, sourceFrameId = 0) => fire('created', { tabId, sourceTabId, sourceFrameId }),
    setUrl: (tabId, url) => urls.set(tabId, url),
  };
}
const LOGIN = 'https://login.microsoftonline.com/common/oauth2/authorize';
const EVIL = 'https://evil.example/phish';

test('tabs: the first page of a tab nobody opened (the app\'s click, a new tab) may start a sign-in', async () => {
  const b = await browser();
  await b.commit(5, 'https://entra.microsoft.com/', 'link');
  await b.commit(5, LOGIN, 'link', ['server_redirect']);
  assert.equal(await b.mayStart(5), true);
});

test('tabs: a foreign page that sends its own tab to the sign-in, by script or redirect, starts nothing', async () => {
  const b = await browser();
  await b.commit(6, EVIL, 'typed'); // the user went there
  await b.commit(6, LOGIN, 'link', ['client_redirect']); // the page sent the tab on
  assert.equal(await b.mayStart(6), false);
  await b.commit(6, EVIL, 'link');
  await b.commit(6, LOGIN, 'link');
  assert.equal(await b.mayStart(6), false);
});

test('tabs: window.open and target=_blank (also noopener) from a foreign page start nothing, from Microsoft they do', async () => {
  const b = await browser();
  await b.commit(1, EVIL, 'typed');
  await b.commit(2, 'https://portal.azure.com/', 'typed');
  await b.opened(7, 1);
  await b.commit(7, 'about:blank');
  await b.commit(7, LOGIN, 'link');
  assert.equal(await b.mayStart(7), false, 'foreign opener, via about:blank');
  await b.opened(8, 1);
  await b.commit(8, LOGIN, 'link');
  assert.equal(await b.mayStart(8), false, 'foreign opener, straight to the sign-in');
  await b.opened(9, 2);
  await b.commit(9, LOGIN, 'link');
  assert.equal(await b.mayStart(9), true, 'the Azure portal opened it');
});

test('tabs: a Microsoft page reached through a foreign page does not count, an address the user types does', async () => {
  const b = await browser();
  await b.commit(10, 'https://portal.azure.com/', 'typed');
  await b.commit(10, EVIL, 'link'); // a link on the portal
  await b.commit(10, LOGIN, 'link', ['client_redirect']);
  assert.equal(await b.mayStart(10), false);
  await b.commit(10, LOGIN, 'typed', ['from_address_bar']);
  assert.equal(await b.mayStart(10), true);
});

test('tabs: tabs that existed before are unknown and never start one; an iframe needs a Microsoft main page', async () => {
  const b = await browser([{ id: 11, url: LOGIN }]);
  await b.startup();
  assert.equal(await b.mayStart(11), false);
  await b.commit(13, LOGIN, 'link');
  await b.startup();
  assert.equal(await b.mayStart(13), true, 'a state that is known stays');
  await b.commit(12, LOGIN, 'link');
  assert.equal(await b.mayStart(12), true);
  assert.equal(await b.mayStart(12, { frameId: 3, tabUrl: EVIL }), false, 'login page in an iframe of a foreign page');
  assert.equal(await b.mayStart(12, { frameId: 3, tabUrl: 'https://portal.azure.com/' }), true);
  assert.equal(await b.mayStart(undefined), false);
});

test('tabs: the asking page must be the page the state was recorded for (opener navigated the tab)', async () => {
  const b = await browser();
  await b.commit(40, 'https://portal.azure.com/', 'typed');
  assert.equal(await b.mayStart(40, { tabUrl: 'https://portal.azure.com/x' }), true);
  assert.equal(await b.mayStart(40, { tabUrl: EVIL }), false, 'tab shows another page than recorded');
});

test('the extension watches the tabs and asks before the job and the automatic start (#372)', () => {
  const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(bg, /^watchTabs\(\);$/m);
  const signIn = bg.slice(bg.indexOf("'cs:signIn':"), bg.indexOf("'cs:signInDone':"));
  assert.match(signIn, /!\(await mayStartSignIn\(sender\)\)\) return null/);
  assert.match(signIn, /app\.signIn\(host, await tabKey\(sender\)\)/);
  const accounts = bg.slice(bg.indexOf("'cs:msAccounts':"), bg.indexOf("'cs:msAccount':"));
  assert.match(accounts, /paused: !!msSignedOut \|\| foreign/);
  assert.match(accounts, /mayStartSignIn\(sender, \{ auto: true \}\)/, 'the remembered account needs more than the app\'s job');
  assert.match(bg.slice(bg.indexOf("'cs:signInDone':"), bg.indexOf("'cs:bastionConnected':")), /if \(!mainPageFits\(sender\)\) return null/);
  assert.match(readFileSync(new URL('../extension/lib/desktop.js', import.meta.url), 'utf8'), /signIn: \(host, tab\) => call\('signIn', \{ host, tab \}\)/);
  assert.match(readFileSync(new URL('../desktop/main/browser.js', import.meta.url), 'utf8'), /signInFor\(host, tab\)/);
});

// Final review (Konrad): trust passes on only from a trusted Microsoft page; the opener's state counts, not its URL now.
test('tabs: foreign page, then Microsoft, then Microsoft again stays untrusted (window.open chain, F1)', async () => {
  const b = await browser();
  await b.commit(1, EVIL, 'typed');
  await b.opened(20, 1);
  await b.commit(20, LOGIN, 'link'); // opened by a foreign page: ok false, last is Microsoft
  assert.equal(await b.mayStart(20), false);
  await b.commit(20, 'https://login.microsoftonline.com/common/oauth2/step2', 'link'); // the next navigation
  assert.equal(await b.mayStart(20), false, 'not trusted by the Microsoft page before it');
  await b.commit(20, 'https://login.microsoftonline.com/common/oauth2/step3', 'link');
  assert.equal(await b.mayStart(20), false);
  assert.equal(await b.mayStart(20, { auto: true }), false);
});

test('tabs: a reload does not make an untrusted Microsoft page trusted, a trusted one stays', async () => {
  const b = await browser();
  await b.commit(1, EVIL, 'typed');
  await b.opened(21, 1);
  await b.commit(21, LOGIN, 'link');
  await b.commit(21, LOGIN, 'reload');
  assert.equal(await b.mayStart(21), false);
  await b.commit(22, 'https://portal.azure.com/', 'typed');
  await b.commit(22, 'https://portal.azure.com/', 'reload');
  assert.equal(await b.mayStart(22), true);
  assert.equal(await b.mayStart(22, { auto: true }), false, 'auto only along a server redirect (#429)');
});

test('tabs: a restored tab on a Microsoft page is not trusted by its next page change', async () => {
  const b = await browser([{ id: 23, url: LOGIN }]);
  await b.startup();
  await b.commit(23, 'https://login.microsoftonline.com/common/oauth2/step2', 'link');
  assert.equal(await b.mayStart(23), false);
  await b.commit(23, 'https://portal.azure.com/', 'link');
  assert.equal(await b.mayStart(23), false);
});

test('tabs: the opener counts by its state at that time, a frame never passes trust on (F2)', async () => {
  const b = await browser();
  await b.commit(2, 'https://portal.azure.com/', 'typed');
  await b.opened(24, 2, 3); // opened by an iframe of the portal (could be a foreign frame)
  await b.commit(24, LOGIN, 'link');
  assert.equal(await b.mayStart(24), false, 'frame of a Microsoft page');
  // The opener's URL changed to a foreign page after the click: its state now is the foreign page, so the tab it opens
  // from there is not trusted; tabs.get/getFrame (the current URL) are no longer asked at all.
  await b.commit(2, EVIL, 'link');
  await b.opened(25, 2);
  await b.commit(25, LOGIN, 'link');
  assert.equal(await b.mayStart(25), false);
  // An opener that is itself untrusted does not pass trust on even when it shows a Microsoft page.
  await b.commit(1, EVIL, 'typed');
  await b.opened(26, 1);
  await b.commit(26, LOGIN, 'link'); // untrusted tab on a Microsoft page
  await b.opened(27, 26);
  await b.commit(27, LOGIN, 'link');
  assert.equal(await b.mayStart(27), false, 'untrusted Microsoft page opens nothing trusted');
});

test('tabs: the remembered account starts only after a typed address or a trusted Microsoft page, not in a new tab (F3)', async () => {
  const b = await browser();
  await b.commit(30, LOGIN, 'link'); // new tab without history
  assert.equal(await b.mayStart(30), true, 'the app\'s job still runs there');
  assert.equal(await b.mayStart(30, { auto: true }), false, 'the remembered account does not');
  // Link from a mail (Outlook) handed over at program start: Chromium reports start_page, which is not the user's typing.
  await b.commit(35, LOGIN, 'start_page');
  assert.equal(await b.mayStart(35), true, 'the app\'s job runs in a start_page tab');
  assert.equal(await b.mayStart(35, { auto: true }), false, 'start_page never starts the remembered account');
  await b.commit(36, 'https://portal.azure.com/', 'typed');
  await b.commit(36, LOGIN, 'start_page'); // also with a tab state before it
  assert.equal(await b.mayStart(36), true);
  assert.equal(await b.mayStart(36, { auto: true }), false);
  await b.commit(31, LOGIN, 'typed', ['from_address_bar']);
  assert.equal(await b.mayStart(31, { auto: true }), true);
  await b.commit(32, 'https://portal.azure.com/', 'typed');
  await b.commit(32, LOGIN, 'link', ['server_redirect']);
  assert.equal(await b.mayStart(32, { auto: true }), true, 'trusted Microsoft page before it');
  // A typed foreign address that redirects to Microsoft is not typing.
  await b.commit(33, EVIL, 'typed');
  await b.commit(33, LOGIN, 'typed', ['from_address_bar', 'server_redirect']);
  assert.equal(await b.mayStart(33), false);
  assert.equal(await b.mayStart(33, { auto: true }), false);
  // The same in a new tab: not typed, so no auto; job as for any first page.
  await b.commit(34, LOGIN, 'typed', ['from_address_bar', 'server_redirect']);
  assert.equal(await b.mayStart(34, { auto: true }), false);
  assert.equal(await b.mayStart(34), true);
});

test('tabs: auto passes on along a redirect, not along a link or back and forward (#427)', async () => {
  const b = await browser();
  // A foreign frame or a window with an opener sends a trusted Microsoft tab to the sign-in with its own parameters.
  await b.commit(40, 'https://portal.azure.com/', 'typed');
  await b.commit(40, `${LOGIN}?client_id=evil`, 'link');
  assert.equal(await b.mayStart(40), true, 'the app\'s job may still run');
  assert.equal(await b.mayStart(40, { auto: true }), false, 'the remembered account does not start after a link');
  await b.commit(41, 'https://admin.microsoft.com/', 'typed');
  await b.commit(41, LOGIN, 'link', ['server_redirect'], 'https://admin.microsoft.com/login');
  assert.equal(await b.mayStart(41, { auto: true }), true, 'portal → sign-in by server redirect');
  await b.commit(43, 'https://admin.microsoft.com/', 'typed');
  await b.commit(43, LOGIN, 'link', ['client_redirect']);
  assert.equal(await b.mayStart(43, { auto: true }), false, 'a script\'s navigation (also an opener\'s) passes no auto (#429)');
  // Back and forward keep "typed" and from_address_bar of the entry: no typing now.
  await b.commit(42, 'https://portal.azure.com/', 'link');
  await b.commit(42, LOGIN, 'typed', ['forward_back', 'from_address_bar']);
  assert.equal(await b.mayStart(42, { auto: true }), false);
});

test('tabs: a link on a Microsoft page to a foreign address that redirects to the sign-in counts as foreign (#429)', async () => {
  const b = await browser();
  await b.commit(50, 'https://portal.azure.com/', 'typed');
  await b.commit(50, `${LOGIN}?client_id=evil`, 'link', ['server_redirect'], EVIL);
  assert.equal(await b.mayStart(50), false, 'the foreign page started it');
  assert.equal(await b.mayStart(50, { auto: true }), false);
  // A redirect without a known start counts as foreign as well.
  await b.commit(51, 'https://portal.azure.com/', 'typed');
  await b.commit(51, LOGIN, 'link', ['server_redirect'], '');
  assert.equal(await b.mayStart(51), false);
});

test('tabs: a window a trusted Microsoft page opens may take the job but never auto (#429)', async () => {
  const b = await browser();
  await b.commit(52, 'https://portal.azure.com/', 'typed');
  await b.opened(53, 52);
  await b.commit(53, `${LOGIN}?client_id=evil`, 'link');
  assert.equal(await b.mayStart(53), true);
  assert.equal(await b.mayStart(53, { auto: true }), false);
});
