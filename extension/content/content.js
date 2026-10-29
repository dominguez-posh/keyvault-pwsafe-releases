// Isolated-world content script: relays WebAuthn requests from the MAIN-world shim, shows the field menu
// (logins + passkeys for this site), fills forms and offers to save submitted logins.
(() => {
  'use strict';
  if (globalThis.__kvpwsafeContent) return;
  globalThis.__kvpwsafeContent = true;

  const CHANNEL = 'kvpwsafe-webauthn-v1';
  const isTop = window.top === window;
  let alive = true;

  async function call(cmd, args = {}) {
    if (!alive) throw new Error('inactive');
    try {
      const res = await chrome.runtime.sendMessage({ cmd, ...args });
      if (!res) throw new Error('Keine Antwort');
      if (!res.ok) throw Object.assign(new Error(res.error.message), { name: res.error.name });
      return res.result;
    } catch (e) {
      if (/context invalidated/i.test(e.message)) alive = false;
      throw e;
    }
  }

  // ------------------------------------------------------------ WebAuthn relay

  const toPage = (msg) => window.postMessage({ channel: CHANNEL, dir: 'toPage', ...msg }, '*');
  const modalRequests = new Map(); // extension request id → page id
  let conditional = null; // { requestId, pageId, candidates, locked, lockedContainers }
  let texts = {}; // texts in the user's language, delivered by the service worker

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.channel !== CHANNEL || d.dir !== 'toExt' || !alive) return;
    if (d.abort) {
      abortFromPage(d.id);
      return;
    }
    toPage({ id: d.id, ack: true });
    call('cs:webauthn', { kind: d.kind, options: d.payload, mediation: d.payload?.conditional ? 'conditional' : undefined })
      .then((res) => {
        if (res.pending) {
          modalRequests.set(res.pending, d.id);
          pendingKinds.set(res.pending, d.kind);
          passkeyAnim('wait', texts.passkeyWait || 'Keevault …');
        } else if (res.conditional) {
          conditional = { pageId: d.id, ...res.conditional };
          if (res.conditional.ui) texts = res.conditional.ui;
          if (document.activeElement instanceof HTMLInputElement) onFocus({ target: document.activeElement });
        } else toPage({ id: d.id, fallback: true });
      })
      .catch(() => toPage({ id: d.id, fallback: true }));
  });

  function abortFromPage(pageId) {
    passkeyAnim('hide');
    for (const [requestId, pid] of modalRequests) {
      if (pid !== pageId) continue;
      modalRequests.delete(requestId);
      call('cs:webauthnAbort', { requestId }).catch(() => {});
    }
    if (conditional?.pageId === pageId) {
      call('cs:webauthnAbort', { requestId: conditional.requestId }).catch(() => {});
      conditional = null;
      hideMenu();
    }
  }

  async function refreshConditional() {
    if (!conditional) return;
    const res = await call('cs:webauthnCandidates', { requestId: conditional.requestId }).catch(() => null);
    if (res && conditional) Object.assign(conditional, res);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg?.type) return undefined;
    if (msg.type === 'webauthn:result') {
      const pageId = modalRequests.get(msg.requestId);
      const kind = pendingKinds.get(msg.requestId);
      pendingKinds.delete(msg.requestId);
      if (pageId) {
        modalRequests.delete(msg.requestId);
        if (msg.result) passkeyAnim('ok', kind === 'create' ? (texts.passkeyCreated || 'Passkey') : (texts.passkeyOk || 'Passkey'));
        else passkeyAnim('hide');
        toPage({ id: pageId, result: msg.result, error: msg.error, fallback: msg.fallback });
      }
    } else if (msg.type === 'fill') {
      sendResponse({ filled: fill(msg, lastFocused) });
    } else if (msg.type === 'state:changed') {
      matches = null;
      hideMenu();
      refreshConditional();
    } else if (msg.type === 'save:show' && isTop) {
      showSaveBanner(msg.info);
    }
    return undefined;
  });

  // ------------------------------------------------------------ fields

  const USER_HINT = /user|login|e-?mail|account|konto|benutzer|anmelde|identifier|kennung/i;
  const SUBMIT_HINT = /log ?in|sign ?in|anmeld|einlogg|weiter|next|continue|submit|register|registrier|speichern|save|ändern|change/i;

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const usable = (el) => el instanceof HTMLInputElement && !el.disabled && !el.readOnly && visible(el);
  const isPassword = (el) => el instanceof HTMLInputElement && el.type === 'password';
  const isTextual = (el) => el instanceof HTMLInputElement && ['text', 'email', 'tel', 'search', ''].includes(el.type);
  function isUsernameLike(el) {
    if (!isTextual(el)) return false;
    const ac = (el.autocomplete || '').toLowerCase();
    if (/username|email|webauthn/.test(ac)) return true;
    return USER_HINT.test(`${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') || ''}`);
  }

  const OTP_HINT = /one.?time|otp|totp|2fa|mfa|two.?factor|einmal|verif|bestätigung|security.?code|sicherheitscode|auth.*code|\bcode\b|\btoken\b|pin/i;

  /** Field for a one-time code (TOTP): autocomplete="one-time-code" or typical names, short numeric input. */
  function isOtpField(el) {
    if (!(el instanceof HTMLInputElement) || !['text', 'tel', 'number', 'password', ''].includes(el.type)) return false;
    if ((el.autocomplete || '').toLowerCase() === 'one-time-code') return true;
    const max = Number(el.maxLength);
    if (max > 0 && (max < 1 || max > 10)) return false;
    const hint = `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') || ''} ${el.className}`;
    return OTP_HINT.test(hint) && !USER_HINT.test(hint) && !/current-password|new-password/.test(el.autocomplete || '');
  }

  /** Some sites split the code into one field per digit: spread it over the following single-character fields. */
  function fillOtp(target, code) {
    if (Number(target.maxLength) === 1) {
      const scope = target.form || target.closest('div, section, form') || document;
      const boxes = [...scope.querySelectorAll('input')].filter((i) => usable(i) && Number(i.maxLength) === 1);
      const start = Math.max(0, boxes.indexOf(target));
      [...code].forEach((digit, i) => boxes[start + i] && setValue(boxes[start + i], digit));
      return;
    }
    setValue(target, code);
  }

  function loginFields(scope) {
    const inputs = [...scope.querySelectorAll('input')].filter(usable);
    const passwords = inputs.filter(isPassword);
    const password = passwords.find((p) => /current-password/.test(p.autocomplete)) || passwords[0] || null;
    const texts = inputs.filter(isTextual);
    let username;
    if (password) {
      const before = texts.filter((t) => t.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
      username = before.find((t) => /username|email/.test(t.autocomplete)) || before.reverse().find(isUsernameLike) || before[0] || null;
    } else {
      username = texts.find((t) => /username|email/.test(t.autocomplete)) || texts.find(isUsernameLike) || null;
    }
    return { username, password };
  }

  function setValue(el, value) {
    el.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fill({ username, password }, start) {
    const scopes = [start?.form, start?.closest?.('form'), document].filter(Boolean);
    for (const scope of scopes) {
      const f = loginFields(scope);
      if (!f.username && !f.password) continue;
      let filled = false;
      if (f.username && username) {
        setValue(f.username, username);
        filled = true;
      }
      if (f.password && password) {
        setValue(f.password, password);
        filled = true;
      }
      if (filled) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ UI host (closed shadow root)

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, sans-serif; }
    .menu, .banner { position: fixed; background: #fff; color: #1b1b1f; border: 1px solid #d0d4dc; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18); font-size: 13px; overflow: hidden; }
    .menu { min-width: 260px; max-width: 380px; max-height: 320px; overflow-y: auto; padding: 4px; }
    .head { display: flex; align-items: center; gap: 6px; padding: 6px 8px 4px; font-size: 11px; color: #5b6170; text-transform: uppercase; letter-spacing: .04em; }
    .entry { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: none; padding: 8px; border-radius: 7px; cursor: pointer; text-align: left; color: inherit; font-size: 13px; }
    .entry:hover, .entry:focus { background: #eef3fb; outline: none; }
    .avatar { flex: none; width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center; color: #fff; font-weight: 600; background: #0f6cbd; }
    .avatar.pk { background: #5b4fc4; }
    .avatar.lock { background: #5b6170; }
    .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .s { color: #5b6170; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .txt { min-width: 0; }
    .banner { top: 16px; right: 16px; width: 340px; padding: 14px 16px; }
    .banner .title { font-weight: 600; margin-bottom: 4px; display: flex; gap: 8px; align-items: center; }
    .banner .user { color: #5b6170; margin: 2px 0 10px; word-break: break-all; }
    .banner select { width: 100%; margin-bottom: 10px; padding: 6px; border-radius: 6px; border: 1px solid #c4c9d4; font-size: 13px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    button.b { border: 1px solid #c4c9d4; background: #fff; color: #1b1b1f; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    button.b.primary { background: #0f6cbd; border-color: #0f6cbd; color: #fff; }
    button.x { position: absolute; top: 8px; right: 8px; border: 0; background: none; font-size: 18px; cursor: pointer; color: #5b6170; }
    .logo { width: 18px; height: 18px; border-radius: 5px; background: #0f6cbd; display: inline-grid; place-items: center; color: #fff; font-size: 11px; }
    .pk { position: fixed; top: 16px; right: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 12px; padding: 12px 16px 12px 12px;
      background: #fff; color: #1b1b1f; border: 1px solid #d0d4dc; border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.2); font-size: 13px;
      animation: pk-in .22s cubic-bezier(.2,.8,.2,1); }
    .pk.hide { animation: pk-out .25s ease forwards; }
    .pk .disc { position: relative; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; flex: none; }
    .pk .ring { position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(#0f6cbd 0 25%, #dfe6f3 25% 100%); animation: pk-spin .9s linear infinite;
      -webkit-mask: radial-gradient(circle, transparent 60%, #000 62%); mask: radial-gradient(circle, transparent 60%, #000 62%); }
    .pk .glyph { position: relative; width: 22px; height: 22px; color: #0f6cbd; animation: pk-key 1.2s ease-in-out infinite; }
    .pk .glyph svg { width: 22px; height: 22px; display: block; }
    .pk .check { display: none; position: relative; width: 22px; height: 22px; }
    .pk .check svg { width: 22px; height: 22px; display: block; }
    .pk.ok .ring { animation: none; background: #1f9d55; -webkit-mask: radial-gradient(circle, transparent 60%, #000 62%); mask: radial-gradient(circle, transparent 60%, #000 62%); }
    .pk.ok .glyph { display: none; }
    .pk.ok .check { display: block; color: #1f9d55; animation: pk-pop .35s cubic-bezier(.2,.9,.3,1.4); }
    .pk .pktxt { font-weight: 600; max-width: 260px; }
    .pk .pksub { color: #5b6170; font-size: 11px; margin-top: 2px; }
    @keyframes pk-spin { to { transform: rotate(360deg); } }
    @keyframes pk-key { 0%, 100% { transform: translateY(0) rotate(-8deg); } 50% { transform: translateY(-2px) rotate(8deg); } }
    @keyframes pk-pop { from { transform: scale(.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    @keyframes pk-in { from { transform: translateY(-10px); opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes pk-out { to { transform: translateY(-8px); opacity: 0; } }
    @media (prefers-color-scheme: dark) {
      .menu, .banner, .pk { background: #23252b; color: #eceef2; border-color: #3a3d46; }
      .pk .ring { background: conic-gradient(#5aa0ff 0 25%, #3a3d46 25% 100%); }
      .pk .pksub { color: #a6abb8; }
      .entry:hover, .entry:focus { background: #2f3440; }
      .head, .s, .banner .user, button.x { color: #a6abb8; }
      button.b { background: #2b2e36; color: #eceef2; border-color: #464a55; }
      .banner select { background: #2b2e36; color: #eceef2; border-color: #464a55; }
    }`;

  let host = null;
  let root = null;
  let pk = null; // passkey animation card
  let pkTimer = null;
  const pendingKinds = new Map(); // extension request id → 'get' | 'create'
  const KEY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3M18.5 4.5l3 3"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  /** 'wait' (spinning ring around a key) | 'ok' (green check, fades out) | 'hide' */
  function passkeyAnim(state, text) {
    clearTimeout(pkTimer);
    if (state === 'hide') {
      if (pk) {
        const gone = pk;
        gone.classList.add('hide');
        pkTimer = setTimeout(() => gone.remove(), 260);
        pk = null;
      }
      return;
    }
    if (!pk || !pk.isConnected) {
      pk = el('div', 'pk');
      const disc = el('div', 'disc');
      const glyph = el('div', 'glyph');
      glyph.innerHTML = KEY_SVG;
      const check = el('div', 'check');
      check.innerHTML = CHECK_SVG;
      disc.append(el('div', 'ring'), glyph, check);
      const txt = el('div', 'txt');
      txt.append(el('div', 'pktxt'), el('div', 'pksub', 'Keevault'));
      pk.append(disc, txt);
      ui().append(pk);
    }
    pk.className = `pk ${state}`;
    pk.querySelector('.pktxt').textContent = text || '';
    if (state === 'ok') pkTimer = setTimeout(() => passkeyAnim('hide'), 1500);
  }
  function ui() {
    if (!host || !host.isConnected) {
      host = document.createElement('kvpwsafe-ui');
      root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = CSS;
      root.append(style);
      (document.body || document.documentElement).append(host);
    }
    return root;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function avatarFor(title, extra = '') {
    const a = el('span', `avatar ${extra}`, (String(title || '?').trim()[0] || '?').toUpperCase());
    return a;
  }

  // ------------------------------------------------------------ field menu

  let menu = null;
  let anchor = null;
  let lastFocused = null;
  let matches = null;
  let matchesAt = 0;

  async function getMatches() {
    if (matches && Date.now() - matchesAt < 30_000) return matches;
    matches = await call('cs:matches').catch(() => ({ enabled: false }));
    if (matches.ui) texts = matches.ui;
    matchesAt = Date.now();
    return matches;
  }

  function hideMenu() {
    menu?.remove();
    menu = null;
    anchor = null;
  }

  function position() {
    if (!menu || !anchor) return;
    if (!anchor.isConnected) {
      hideMenu();
      return;
    }
    const r = anchor.getBoundingClientRect();
    const below = window.innerHeight - r.bottom > 200 || r.top < 200;
    menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - 270))}px`;
    menu.style.minWidth = `${Math.max(260, Math.min(r.width, 380))}px`;
    if (below) {
      menu.style.top = `${r.bottom + 4}px`;
      menu.style.bottom = '';
    } else {
      menu.style.top = '';
      menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
    }
  }

  function entryButton(onPick, ...children) {
    const b = el('button', 'entry');
    b.type = 'button';
    b.append(...children);
    // Keep focus in the field; only real user clicks count.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      onPick();
    });
    return b;
  }

  function text(title, sub) {
    const t = el('div', 'txt');
    t.append(el('div', 't', title), el('div', 's', sub));
    return t;
  }

  function showMenu(input, entries) {
    hideMenu();
    anchor = input;
    menu = el('div', 'menu');
    const head = el('div', 'head');
    head.append(el('span', 'logo', 'K'), document.createTextNode('Keevault'));
    menu.append(head);
    for (const e of entries) {
      if (e.kind === 'passkey') {
        menu.append(entryButton(() => usePasskey(e), avatarFor('🔑', 'pk'), text(e.userName || e.title, `${texts.passkey || 'Passkey'} · ${e.title}${e.container ? ` · ${e.container}` : ''}`)));
      } else if (e.kind === 'otp') {
        menu.append(entryButton(() => useOtp(e), avatarFor('⏱', 'pk'), text(e.title, [texts.otp, e.username, e.container].filter(Boolean).join(' · '))));
      } else if (e.kind === 'login') {
        menu.append(entryButton(() => useLogin(e), avatarFor(e.title), text(e.title, [e.username, e.container].filter(Boolean).join(' · '))));
      } else if (e.kind === 'unlock') {
        menu.append(entryButton(() => {
          hideMenu();
          call('cs:unlock').catch(() => {});
        }, avatarFor('🔒', 'lock'), text(texts.unlock, texts.unlockSub)));
      } else if (e.kind === 'containers') {
        menu.append(entryButton(() => {
          hideMenu();
          call('cs:unlockContainers').catch(() => {});
        }, avatarFor('🛡', 'lock'), text(texts.lockedContainers, texts.lockedSub)));
      }
    }
    ui().append(menu);
    position();
  }

  async function useLogin(entry) {
    const target = anchor;
    hideMenu();
    try {
      const creds = await call('cs:fill', { containerId: entry.containerId, id: entry.id });
      fill(creds, target);
    } catch {
      // Ignore: entry no longer available.
    }
  }

  async function useOtp(entry) {
    const target = anchor;
    hideMenu();
    try {
      const { code } = await call('cs:totp', { containerId: entry.containerId, id: entry.id });
      fillOtp(target, code);
    } catch {
      // Entry no longer available or no matching site.
    }
  }

  async function usePasskey(entry) {
    hideMenu();
    const c = conditional;
    if (!c) return;
    passkeyAnim('wait', texts.passkeyWait || 'Keevault …');
    try {
      const res = await call('cs:webauthnSelect', { requestId: c.requestId, containerId: entry.containerId, itemId: entry.itemId, credentialId: entry.credentialId });
      conditional = null;
      passkeyAnim('ok', texts.passkeyOk || 'Passkey');
      toPage({ id: c.pageId, result: res.result });
    } catch {
      passkeyAnim('hide');
      // Request expired; the site can retry.
    }
  }

  async function onFocus(ev) {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement) || !alive) return;
    lastFocused = input;
    const webauthnField = /webauthn/i.test(input.autocomplete || '');
    const otp = isOtpField(input);
    const pw = !otp && isPassword(input);
    const user = !pw && !otp && isUsernameLike(input);
    if (!pw && !user && !webauthnField && !otp) return;
    const data = await getMatches();
    if (document.activeElement !== input) return;
    const entries = [];
    if (conditional && !conditional.locked) for (const c of conditional.candidates || []) entries.push({ kind: 'passkey', ...c });
    if (data.enabled) {
      if (data.locked) {
        if (data.configured) entries.push({ kind: 'unlock' });
      } else {
        // One-time-code field: entries of this site with a TOTP secret; otherwise logins.
        for (const m of data.items || []) if (!otp || m.hasTotp) entries.push({ kind: otp ? 'otp' : 'login', ...m });
        if (data.lockedContainers || conditional?.lockedContainers) entries.push({ kind: 'containers' });
      }
    } else if (conditional?.locked) entries.push({ kind: 'unlock' });
    if (entries.length) showMenu(input, entries);
  }

  document.addEventListener('focusin', (e) => onFocus(e), true);
  document.addEventListener('click', (e) => {
    if (e.isTrusted && e.target instanceof HTMLInputElement && e.target === document.activeElement && !menu) onFocus(e);
  }, true);
  document.addEventListener('focusout', () => setTimeout(() => {
    if (menu && document.activeElement !== anchor) hideMenu();
  }, 150), true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu) hideMenu();
  }, true);
  window.addEventListener('scroll', position, { passive: true, capture: true });
  window.addEventListener('resize', position, { passive: true });

  // ------------------------------------------------------------ save prompt

  let lastUsername = '';
  let lastCapture = '';
  document.addEventListener('input', (e) => {
    if (e.isTrusted && isUsernameLike(e.target) && e.target.value) lastUsername = e.target.value;
  }, true);

  function captureFrom(origin) {
    const scope = origin?.form || origin?.closest?.('form') || document;
    const passwords = [...scope.querySelectorAll('input[type=password]')].filter((p) => p.value);
    if (!passwords.length) return;
    const password = passwords.find((p) => /new-password/.test(p.autocomplete)) || passwords[passwords.length - 1];
    const { username } = loginFields(scope);
    const user = username?.value || lastUsername || '';
    const key = `${user}\u0000${password.value}`;
    if (key === lastCapture) return;
    lastCapture = key;
    call('cs:capture', { username: user, password: password.value }).catch(() => {});
  }

  document.addEventListener('submit', (e) => captureFrom(e.target), true);
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const b = e.target.closest?.('button, input[type=submit], [role=button]');
    if (!b) return;
    const scope = b.form || b.closest('form') || document;
    if (!scope.querySelector('input[type=password]')) return;
    const submitLike = b.type === 'submit' || (b.tagName === 'BUTTON' && !b.getAttribute('type') && b.form) ||
      SUBMIT_HINT.test(`${b.textContent} ${b.value || ''} ${b.getAttribute('aria-label') || ''}`);
    if (submitLike) captureFrom(b);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.isTrusted && e.key === 'Enter' && isPassword(e.target)) captureFrom(e.target);
  }, true);

  let banner = null;
  function showSaveBanner(info) {
    if (!info || info.action === 'none') return;
    if (info.ui) texts = info.ui;
    banner?.remove();
    banner = el('div', 'banner');
    const close = el('button', 'x', '×');
    close.title = texts.close;
    close.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      banner.remove();
      call('cs:dismissCaptured', { never: false }).catch(() => {});
    });
    const title = el('div', 'title');
    title.append(el('span', 'logo', 'K'), document.createTextNode(info.action === 'update' ? texts.updateTitle : texts.saveTitle));
    const desc = el('div', '', info.action === 'update' ? `„${info.title}“ (${info.host})` : info.host);
    const user = el('div', 'user', info.username || texts.noUser);
    banner.append(close, title, desc, user);
    let select = null;
    if (info.action === 'save' && info.containers.length > 1) {
      select = el('select');
      for (const c of info.containers) {
        const o = el('option', '', c.name);
        o.value = c.id;
        o.selected = c.id === info.defaultContainer;
        select.append(o);
      }
      banner.append(select);
    }
    const row = el('div', 'row');
    const save = el('button', 'b primary', info.action === 'update' ? texts.update : texts.save);
    save.addEventListener('click', async (e) => {
      if (!e.isTrusted) return;
      save.disabled = true;
      try {
        await call('cs:saveCaptured', { containerId: select?.value || info.defaultContainer });
        banner.replaceChildren(title, el('div', '', texts.saved));
        setTimeout(() => banner?.remove(), 2500);
      } catch (err) {
        save.disabled = false;
        desc.textContent = err.message;
      }
    });
    const never = el('button', 'b', texts.never);
    never.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      banner.remove();
      call('cs:dismissCaptured', { never: true }).catch(() => {});
    });
    row.append(save);
    if (info.action === 'save') row.append(never);
    banner.append(row);
    ui().append(banner);
  }

  if (isTop) {
    const checkPending = () => call('cs:pending').then(showSaveBanner).catch(() => {});
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkPending, { once: true });
    else checkPending();
  }
})();
