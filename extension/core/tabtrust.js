// Which tabs may start a Microsoft sign-in by themselves (#372). A page of anyone can send the browser to Microsoft's
// sign-in: window.open, a link with target=_blank (also with noopener), a redirect in the same tab. Such a tab must not
// get the app's one-click job or the remembered account. The tab remembers how it came about:
//  - opened by a page (webNavigation.onCreatedNavigationTarget): trusted only when that page is a Microsoft page,
//  - otherwise each page counts by the page before it in the same tab: a Microsoft page, or an address typed by the user,
//  - the first page of a tab nobody's page opened (the app's click, a new tab) is trusted for the app's job,
//  - trust is passed on only by a trusted Microsoft page (state.ok and microsoftPage(state.last)): a page that was not
//    trusted stays untrusted however often it is reloaded or followed by Microsoft pages,
//  - a server redirect counts by where the navigation started (webNavigation.onBeforeNavigate): a link on a Microsoft
//    page to a foreign address that redirects to the sign-in is the foreign page's doing, never committed (#429),
//  - the remembered account starts by itself only with `auto`: an address the user typed (not a redirect of it, not
//    back or forward), or a server redirect from a trusted Microsoft page with auto (not a link, not a client redirect,
//    not a window a page opened: #427, #429). A new tab without history (link from a mail or chat) has ok but not auto.
// Microsoft pages are an exact list: host names others can register (*.cloudapp.azure.com, *.blob.core.windows.net,
// *.web.core.windows.net) are not on it.
import { signInPageHost } from './pagefit.js';

// The sign-in pages and the admin centers the app opens (desktop/main/signin.js ADMIN_CENTER_HOSTS).
const MICROSOFT_PAGES = new Set([
  'login.microsoftonline.com', 'login.microsoft.com', 'login.live.com', 'portal.azure.com', 'portal.azure.net',
  'admin.microsoft.com', 'entra.microsoft.com', 'intune.microsoft.com', 'security.microsoft.com', 'purview.microsoft.com',
  'admin.exchange.microsoft.com', 'admin.teams.microsoft.com',
]);
// A Bastion host's own address (shareable link): one label below bastion.azure.com, content from Microsoft.
const BASTION_HOST = /^[a-z0-9-]+\.bastion\.azure\.com$/i;

/** True for an https page (standard port) of one of the Microsoft hosts above. */
export function microsoftPage(url) {
  const host = signInPageHost(String(url || '')).toLowerCase();
  return !!host && (MICROSOFT_PAGES.has(host) || BASTION_HOST.test(host));
}

const USER_ENTERED = new Set(['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated']);
// Chromium reports addresses handed over at program start (mail link from Outlook, command line) as start_page: that is
// the app's tab at best, never the user's typing. Always ok (the app's job runs), never auto.
const START_PAGE = 'start_page';

// A redirect is not the user's typing: a typed foreign address may send the tab on to Microsoft by server or script.
const REDIRECTS = ['server_redirect', 'client_redirect'];

/**
 * State of a tab created by a page. source: the state of the opener's tab, in event order (not the tab's URL now, which
 * may have moved on) and the frame that opened it; only the main frame of a trusted Microsoft page passes trust on.
 */
export function openedBy(source, frameId = 0) {
  const ok = frameId === 0 && source?.ok === true && microsoftPage(source.last);
  // Never auto: the opening page chose the target, possibly a sign-in with its own parameters (#429).
  return { ok, auto: false, last: '', opened: true };
}

/**
 * State after the tab's main frame committed a page. state: the tab's state before (undefined: none known).
 * nav: { url, type (transitionType), qualifiers (transitionQualifiers), start (URL the navigation started with) }.
 */
export function afterCommit(state, { url, type, qualifiers = [], start = '' }) {
  let ok;
  let auto;
  const redirect = qualifiers.some((q) => REDIRECTS.includes(q));
  // Back and forward keep the type of the entry (typed) and from_address_bar: that is no typing now (#427).
  const typed = (USER_ENTERED.has(type) || qualifiers.includes('from_address_bar')) && !redirect && !qualifiers.includes('forward_back');
  if (type === START_PAGE) { ok = true; auto = false; }
  else if (typed) ok = auto = true;
  else if (!state) { ok = true; auto = false; }
  else if (state.opened && !state.last) { ok = state.ok === true; auto = ok && state.auto === true; }
  else { // trust only passes on from a trusted Microsoft page, a reload of an untrusted page stays untrusted
    // A server redirect: the page it started at decides as well – unknown counts as foreign (#429).
    const server = qualifiers.includes('server_redirect');
    ok = state.ok === true && microsoftPage(state.last) && (!server || microsoftPage(start));
    // auto only along a server redirect of a Microsoft page (portal → sign-in), not along a link or a script's
    // navigation: a foreign frame or a window with an opener can send a trusted Microsoft tab to the sign-in with its
    // own parameters (#427, #429).
    auto = ok && server && state.auto === true;
  }
  return { ok, auto, last: String(url || ''), opened: false };
}

/** A tab nobody told us about (before the extension ran, session storage lost): never trusted. */
export const unknownTab = (url) => ({ ok: false, auto: false, last: String(url || ''), opened: false });

/** The sender's own frame may be an iframe of a foreign page: then the main page decides. */
export const mainPageFits = (sender) => sender.frameId === 0 || sender.frameId == null || microsoftPage(sender.tab?.url);
