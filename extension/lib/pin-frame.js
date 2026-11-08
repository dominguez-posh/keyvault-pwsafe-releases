// #465: the app PIN for a passkey sign-in is typed in the Keevault tag at the top of the page – in a frame of the
// extension (pin/pin.html), not in the page: the page can neither read its keystrokes nor script it (#409). The frame
// talks to the service worker only (never postMessage with the page). It counts only in the tab and for the request
// whose tag opened it, and the PIN goes to the app only after that tag reports the frame as really visible for a while
// (visible-guard.js, #373/#401). The app checks the PIN for exactly this use (passkeySign, #439).
//
// The page is web-accessible with use_dynamic_url: where the browser enforces it, the page is served only under the
// extension's per-session id (runtime.getURL gives that URL), so a page cannot probe the fixed id to learn that
// Keevault is installed. The frame then has that dynamic origin, not the one of the extension's own pages.

import { t } from '../core/i18n.js';

export const PIN_PAGE = 'pin/pin.html';
/** What the PIN page asks the worker for; a sender of the dynamic origin gets nothing else. */
export const PIN_PAGE_COMMANDS = new Set(['state', 'webauthn:pinFrame', 'webauthn:pinApprove', 'webauthn:cancel']);

/** Where our PIN page may be: what runtime.getURL gives (the dynamic id where the browser uses it) and the fixed id. */
const pinPageUrls = () => [chrome.runtime.getURL(PIN_PAGE), ...(chrome.runtime.id ? [`chrome-extension://${chrome.runtime.id}/${PIN_PAGE}`] : [])];

/** The sender is our PIN page under one of those origins, exactly that page. */
export function isPinPage(sender, pageUrl = pinPageUrls()) {
  if (typeof sender?.url !== 'string') return false;
  try {
    const u = new URL(sender.url);
    const origin = (x) => `${x.protocol}//${x.host}`; // URL.origin is "null" for chrome-extension: outside the browser
    if (sender.origin && sender.origin !== origin(u)) return false;
    return [pageUrl].flat().some((p) => {
      const page = new URL(p);
      return origin(u) === origin(page) && u.pathname === page.pathname;
    });
  } catch {
    return false;
  }
}

/** A command of the PIN page under its dynamic origin: like an extension page, but only for its own commands. */
export const pinPageCommand = (sender, cmd) => PIN_PAGE_COMMANDS.has(cmd) && isPinPage(sender);

/** The frame of this request's tag: a sign-in offered with the PIN in the bar, our page, inside the asking tab. */
export function frameFits(req, sender, pageUrl = pinPageUrls()) {
  return !!req && req.kind === 'get' && req.pinBar === true && !!sender?.tab && sender.tab.id === req.tabId
    && sender.frameId > 0 && isPinPage(sender, pageUrl);
}

/** Asks the content script of the asking document; it answers for its own tag only. */
const toTag = (req, msg) => chrome.tabs.sendMessage(req.tabId, { ...msg, requestId: req.id }, req.documentId ? { documentId: req.documentId } : { frameId: req.frameId });

const invalid = () => new Error(t('Ungültige Anfrage'));

/**
 * Commands of the frame (extension page, so the worker's page commands). deps: { loadRequest, saveRequest, approve,
 * pinState, getFrame }.
 * webauthn:pinFrame – the frame loaded: binds the request to this frame (frameId and documentId; any other frame, also
 *   a reload of it, gets nothing), the tag stops waiting and shows the frame (else the window takes over), PIN state.
 * webauthn:pinApprove – Enter in the frame: only from the bound frame and when the tag says it was visible long
 *   enough, then the app signs.
 * Where the browser reports the frame (webNavigation.getFrame), its parent must be the frame that asked.
 */
export function pinFrameCommands({ loadRequest, saveRequest, approve, pinState, getFrame = (q) => chrome.webNavigation.getFrame(q) }) {
  let queue = Promise.resolve(); // one binding at a time: two frames loading together cannot both bind
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const bound = (msg, sender, bind) => serial(async () => {
    const req = await loadRequest(msg.requestId);
    if (!frameFits(req, sender)) throw invalid();
    const where = await Promise.resolve().then(() => getFrame({ tabId: sender.tab.id, frameId: sender.frameId })).catch(() => null);
    if (where && where.parentFrameId !== req.frameId) throw invalid();
    const own = { frameId: sender.frameId, documentId: sender.documentId || null };
    if (req.pinFrame) {
      if (req.pinFrame.frameId !== own.frameId || req.pinFrame.documentId !== own.documentId) throw invalid();
    } else if (bind) {
      req.pinFrame = own;
      await saveRequest(req);
    } else {
      throw invalid(); // no PIN before the frame announced itself
    }
    return req;
  });
  return {
    'webauthn:pinFrame': async (msg, sender) => {
      const req = await bound(msg, sender, true);
      await toTag(req, { type: 'pinframe:ready' }).catch(() => {});
      return { pin: await pinState(), rpId: req.rpId };
    },
    'webauthn:pinApprove': async (msg, sender) => {
      const req = await bound(msg, sender, false);
      const seen = await toTag(req, { type: 'pinframe:clear' }).catch(() => null);
      if (seen?.clear !== true) throw Object.assign(new Error(t('Nicht angemeldet: Die Leiste war verdeckt, verschoben oder gerade erst erschienen. Bitte die PIN erneut eingeben.')), { name: 'Covered' });
      const { containerId, itemId, credentialId, pin } = msg;
      return approve({ requestId: req.id, containerId, itemId, credentialId, pin: typeof pin === 'string' ? pin : '' });
    },
  };
}
