// Which page may receive sign-in data: the sender's scheme and port count, not only its host.
import { hostFromUrl, itemMatchesHost, urlsFitPage, isStandardHttps } from './match.js';
import { itemHosts, itemUrls } from './model.js';

export const senderPage = (sender) => (sender.origin && sender.origin !== 'null' ? sender.origin : sender.url);

// Stays empty here. Only the extension smoke test's own copy (scripts/extension-smoke.mjs) lists the exact origins of
// its fake sign-in pages, which run over http on a local port; every other page goes through the real checks there too.
const SIGN_IN_TEST_ORIGINS = [];
function isTestOrigin(page) {
  try {
    return SIGN_IN_TEST_ORIGINS.includes(new URL(page).origin);
  } catch {
    return false;
  }
}

// Microsoft and Bastion sign-in data only for the real pages: https on the standard port. A page under the same name
// over http or on another port (a redirected name, a test fake) gets nothing.
export const signInPageHost = (page) => (isStandardHttps(page) || isTestOrigin(page) ? hostFromUrl(page) || '' : '');
export const signInHost = (sender) => signInPageHost(senderPage(sender));

export const itemFitsUrl = (item, page) => (isTestOrigin(page) ? itemMatchesHost(itemHosts(item), hostFromUrl(page)) : urlsFitPage(itemUrls(item), page));
export const itemFitsPage = (item, sender) => itemFitsUrl(item, senderPage(sender));

/**
 * The field menu's entries for the sending page. The list only knows hosts, so each candidate's URLs are read: only
 * when a field is focused, at most every 30 s (content.js), and mostly from the item cache. Unreadable means not shown.
 */
export async function matchesForPage(vault, sender) {
  const page = senderPage(sender);
  const found = await vault.matchesForHost(hostFromUrl(page));
  if (isTestOrigin(page)) return found;
  const fits = await Promise.all(found.map(async (m) => {
    const item = await vault.getItem(m.containerId, m.id).catch(() => null);
    return !!item && itemFitsUrl(item, page);
  }));
  return found.filter((_, i) => fits[i]);
}

/** The entry the fill shortcut uses on this page: the newest of those that fit, or null. */
export async function newestMatchForPage(vault, page) {
  if (!hostFromUrl(page)) return null;
  const fitting = await matchesForPage(vault, { url: page });
  return fitting.sort((a, b) => b.updated - a.updated)[0] || null;
}

/**
 * The saved login a submitted password belongs to, or null. Only an entry that fits the sending page counts: any other
 * page must learn nothing about the stored password and must not get to overwrite it.
 */
export async function savedLoginForPage(vault, sender, username) {
  const page = senderPage(sender);
  for (const m of await vault.matchesForHost(hostFromUrl(page))) {
    const item = await vault.getItem(m.containerId, m.id);
    if (itemFitsUrl(item, page) && (item.username || '') === username) return { containerId: m.containerId, id: m.id, item };
  }
  return null;
}
