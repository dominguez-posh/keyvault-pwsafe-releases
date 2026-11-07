// Which tab asks (#372): a key for it that is the same for every message of the tab, and whether the tab may start a
// Microsoft sign-in by itself (core/tabtrust.js has the rules; this file reads the browser's events).
import { openedBy, afterCommit, unknownTab, mainPageFits } from '../core/tabtrust.js';

const KEY = (tabId) => `tabTrust:${tabId}`;
const START = (tabId) => `tabStart:${tabId}`;
let queue = Promise.resolve(); // events are handled one after the other, a question waits for those before it

const later = (job) => {
  queue = queue.then(job).catch(() => {});
  return queue;
};
const read = async (tabId) => (await chrome.storage.session.get(KEY(tabId)))[KEY(tabId)];
const write = (tabId, state) => chrome.storage.session.set({ [KEY(tabId)]: state });

/** Registers the browser events; called once when the service worker starts (listeners must be set synchronously). */
export function watchTabs() {
  // A page opened this tab (window.open, target=_blank, also with noopener): the opener's state at this moment decides,
  // not its URL now (the opener may have navigated on already); a frame never passes trust on.
  chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => later(async () => {
    await write(d.tabId, openedBy(await read(d.sourceTabId), d.sourceFrameId));
  }));
  // Where the main frame's navigation started: a server redirect is judged by it, the redirecting page is never
  // committed (#429).
  chrome.webNavigation.onBeforeNavigate.addListener((d) => {
    if (d.frameId !== 0) return;
    later(() => chrome.storage.session.set({ [START(d.tabId)]: d.url }));
  });
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0) return;
    later(async () => {
      const start = (await chrome.storage.session.get(START(d.tabId)))[START(d.tabId)] || '';
      await write(d.tabId, afterCommit(await read(d.tabId), { url: d.url, type: d.transitionType, qualifiers: d.transitionQualifiers, start }));
      await chrome.storage.session.remove(START(d.tabId));
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove([KEY(tabId), START(tabId)]).catch(() => {}); });
  // Tabs that exist when the extension is installed or the browser starts (restored tabs): history unknown, never trusted.
  // Not at every start of the service worker: it often wakes for the event of a brand-new tab, which must stay trusted.
  const seed = () => later(async () => {
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id != null && tab.url && !(await read(tab.id))) await write(tab.id, unknownTab(tab.url));
    }
  });
  chrome.runtime.onInstalled.addListener(seed);
  chrome.runtime.onStartup.addListener(seed);
}

/**
 * May the sender's tab start a sign-in by itself (the app's job, the remembered account)? Only a tab that came about as
 * described in core/tabtrust.js, and an iframe only when its main page is a Microsoft page (#372). auto: for the remembered
 * account, which needs more than the app's job (typed address or Microsoft page before it, not a new tab without history).
 */
export async function mayStartSignIn(sender, { auto = false } = {}) {
  if (sender.tab?.id == null || !mainPageFits(sender)) return false;
  await queue;
  const state = await read(sender.tab.id);
  if (state?.ok !== true || (auto && state.auto !== true)) return false;
  // The asking page must be the one the state was recorded for: another page in the tab (opener navigated it) is not.
  if (!sender.frameId && sender.tab.url && state.last && originOf(sender.tab.url) !== originOf(state.last)) return false;
  return true;
}

const originOf = (url) => { try { return new URL(url).origin; } catch { return String(url); } };

/** Identifies a tab across browsers and service-worker restarts: random id of this browser's extension plus tab id. */
export async function tabKey(sender) {
  let { kvInstance } = await chrome.storage.session.get('kvInstance');
  if (!kvInstance) {
    kvInstance = crypto.randomUUID();
    await chrome.storage.session.set({ kvInstance });
  }
  return `${kvInstance}:${sender.tab?.id ?? ''}`;
}
