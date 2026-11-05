// Isolated-world content script: relays WebAuthn requests from the MAIN-world shim, shows the field menu
// (logins + passkeys for this site), fills forms and offers to save submitted logins.
(() => {
  'use strict';
  if (globalThis.__kvpwsafeContent) return;
  globalThis.__kvpwsafeContent = true;

  const CHANNEL = 'kvpwsafe-webauthn-v1';
  const isTop = window.top === window;
  let alive = true;
  // The newest instance wins: Chrome keeps the Window when the initial empty document is replaced by the real
  // page and can run the script again in a fresh isolated world – the older instance would then answer every
  // request a second time. The hand-over goes through an event on the shared window (the document differs).
  // Per extension ID: window events reach the content scripts of every extension in the page.
  const TAKEOVER = `kvpwsafe-cs-takeover-${chrome.runtime.id}`;
  window.dispatchEvent(new Event(TAKEOVER));
  window.addEventListener(TAKEOVER, () => { alive = false; host?.remove(); }, { once: true });

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
          // The prompt window covers the page: no waiting card behind it – the success card follows the answer.
        } else if (res.conditional) {
          conditional = { pageId: d.id, ...res.conditional };
          if (res.conditional.ui) texts = res.conditional.ui;
          if (document.activeElement instanceof HTMLInputElement && document.activeElement === engaged) onFocus({ target: document.activeElement });
        } else if (res.inline) {
          showPasskeyPill(d.id, res.inline);
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
    if (inline?.pageId === pageId) {
      call('cs:webauthnAbort', { requestId: inline.requestId }).catch(() => {});
      inline = null;
      hidePill();
    }
  }

  // ------------------------------------------------------------ in-page passkey chooser (bar at the top)
  // A passkey request with passkeys in the vault (or the app locked with a PIN): the Keevault tag hangs below the
  // toolbar icon with a small notch pointing at it – shield, the chosen account (click switches), "Use passkey",
  // and two quiet links: "Other device" hands over to the browser, "Cancel" ends the request.

  let inline = null; // { pageId, kind, requestId, candidates, site, containers, containerId, choice }
  let pill = null; // the tag element (name kept from the earlier bar)
  const SHIELD_PATH = 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z';
  // The Keevault logo (blue tile, white shield, keyhole) drawn inline: no web-accessible image a page could probe.
  // Waiting: the shield breathes and a light sweeps over the tile; success: green stamp. Locked: small padlock.
  let logoSeq = 0;
  const shieldBadge = (locked = false) => {
    const b = el('div', 'badge');
    const g = `kvlg${++logoSeq}`;
    b.innerHTML = `<svg class="logo" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a98ee"/><stop offset="1" stop-color="#0a56a5"/></linearGradient></defs>`
      + `<rect width="48" height="48" rx="12" fill="url(#${g})"/><path class="sweep" d="M-20 48 L8 0 H20 L-8 48Z" fill="#fff" opacity=".18"/>`
      + `<path class="sh" transform="translate(4.8 4.8) scale(1.6)" d="${SHIELD_PATH}" fill="#fff"/>`
      + `<path d="M24 16.5a4 4 0 0 1 2.2 7.3l1.3 7.2h-7l1.3-7.2A4 4 0 0 1 24 16.5z" fill="url(#${g})"/></svg>`;
    if (locked) b.append(el('span', 'lock', '🔒'));
    b.append(el('span', 'stamp', '✓'));
    return b;
  };
  const linkButton = (text, cls, fn) => {
    const b = el('button', `link ${cls}`, text);
    b.type = 'button';
    b.addEventListener('click', (e) => { if (e.isTrusted) fn(); });
    return b;
  };

  function hidePill() {
    if (!pill) return;
    const gone = pill;
    pill = null;
    gone.classList.add('hide');
    setTimeout(() => gone.remove(), 320);
  }

  function newTag(label) {
    clearTimeout(pkTimer); // a success animation still fading out must not take the new tag with it
    hidePill();
    pill = el('div', 'kvtag');
    pill.setAttribute('role', 'dialog');
    pill.setAttribute('aria-label', label);
    return pill;
  }

  function links() {
    const row = el('div', 'links');
    row.append(linkButton(texts.otherDevice || 'Other device', 'link-other', dismissPill), linkButton(texts.cancel || 'Cancel', 'link-cancel', cancelPill));
    return row;
  }

  /** App locked with a PIN: PIN field in the tag; after unlocking the tag continues with the passkeys (or saving). */
  function showPinPill(pageId, info) {
    if (info.ui) texts = info.ui;
    inline = { pageId, kind: 'unlock', requestId: info.requestId, candidates: [], site: info.site, containers: [] };
    const tag = newTag(texts.lockedTitle || 'Keevault');
    const sub = el('div', 'sub', texts.pinPrompt || 'PIN');
    const pin = el('input', 'pin');
    Object.assign(pin, { type: 'password', inputMode: 'numeric', autocomplete: 'off', placeholder: texts.pin || 'PIN' });
    pin.setAttribute('aria-label', texts.pin || 'PIN');
    const go = el('button', 'primary', texts.unlockButton || 'OK');
    go.type = 'button';
    const submit = async () => {
      const cur = inline;
      if (!cur || !pin.value) return;
      go.disabled = true;
      pin.disabled = true;
      sub.textContent = texts.passkeyWait || '…';
      try {
        const r = await call('cs:webauthnUnlock', { requestId: cur.requestId, pin: pin.value });
        if (r.inline) showPasskeyPill(cur.pageId, r.inline);
        else {
          inline = null;
          hidePill();
          toPage({ id: cur.pageId, fallback: true });
        }
      } catch (err) {
        sub.textContent = err.message;
        tag.classList.remove('shake');
        void tag.offsetWidth; // restart the animation
        tag.classList.add('shake');
        go.disabled = false;
        pin.disabled = false;
        pin.value = '';
        pin.focus();
      }
    };
    go.addEventListener('click', (e) => { if (e.isTrusted) submit(); });
    pin.addEventListener('keydown', (e) => { if (e.isTrusted && e.key === 'Enter') submit(); });
    const head = el('div', 'head');
    head.append(el('div', 'title', texts.lockedTitle || 'Keevault'), sub);
    tag.append(shieldBadge(true), head, pin, go, links());
    ui().append(tag);
    pin.focus({ preventScroll: true });
  }

  function showPasskeyPill(pageId, info) {
    if (info.ui) texts = info.ui;
    if (info.kind === 'unlock') return showPinPill(pageId, info);
    inline = { pageId, kind: info.kind || 'get', requestId: info.requestId, candidates: info.candidates || [], site: info.site, containers: info.containers || [], containerId: info.defaultContainer };
    const create = inline.kind === 'create';
    inline.choice = inline.candidates[0];
    // A sign-in the user started (app tile or Microsoft bar) and this is its account's passkey: used without a click.
    if (!create && info.auto && inline.choice) return choosePasskey(inline.choice);
    const tag = newTag(create ? (texts.saveQuestion || 'Passkey') : (texts.choosePasskey || 'Passkey'));

    // The switcher: the current account (sign-in) or vault (saving); a click opens the choices inside the tag.
    const sw = el('button', 'switch');
    sw.type = 'button';
    const who = el('span', 'who');
    const main = el('span', 'main');
    const sub = el('span', 'sub');
    who.append(main, sub);
    sw.append(who, el('span', 'chev', '⌄'));
    const list = el('div', 'list');
    list.hidden = true;
    const draw = () => {
      if (create) {
        const vault = inline.containers.find((c) => c.id === inline.containerId);
        main.textContent = vault?.name || '';
        sub.textContent = info.alreadyRegistered ? (texts.alreadySaved || '') : (info.user || info.rpName || '');
      } else {
        main.textContent = inline.choice?.userName || texts.noUser || '';
        sub.textContent = [inline.choice?.title, inline.choice?.container].filter(Boolean).join(' · ');
      }
    };
    const fill = () => {
      list.replaceChildren();
      const options = create
        ? inline.containers.map((c) => ({ main: c.name, sub: (texts.saveIn || '{vault}').replace('{vault}', c.name), on: c.id === inline.containerId, pick: () => { inline.containerId = c.id; } }))
        : inline.candidates.map((c) => ({ main: c.userName || texts.noUser || '', sub: [c.title, c.container].filter(Boolean).join(' · '), on: c === inline.choice, pick: () => { inline.choice = c; } }));
      for (const o of options) {
        const b = el('button', `opt${o.on ? ' on' : ''}`);
        b.type = 'button';
        b.append(el('span', 'main', o.main), el('span', 'sub', o.sub));
        b.addEventListener('click', (e) => { if (!e.isTrusted) return; o.pick(); draw(); toggle(false); });
        list.append(b);
      }
      // The full window: protected vaults to unlock, more details.
      const win = el('button', 'opt opt-window');
      win.type = 'button';
      win.append(el('span', 'main', texts.otherOptions || '…'));
      win.addEventListener('click', (e) => { if (e.isTrusted) openPromptWindow(); });
      list.append(win);
    };
    const toggle = (open = list.hidden) => {
      if (open) fill();
      list.hidden = !open;
      sw.classList.toggle('open', open);
      sw.querySelector('.chev').textContent = open ? '⌃' : '⌄';
    };
    sw.addEventListener('click', (e) => { if (e.isTrusted) toggle(); });
    draw();

    const use = el('button', 'primary', create ? (texts.savePasskey || 'Save') : (texts.usePasskey || 'Passkey'));
    use.type = 'button';
    use.addEventListener('click', (e) => { if (e.isTrusted) (create ? savePasskey(inline.containerId) : choosePasskey(inline.choice)); });
    const head = create ? el('div', 'title', texts.saveQuestion || 'Passkey') : null;
    tag.append(shieldBadge(), ...(head ? [head] : []), sw, list, use, links());
    ui().append(tag);
    use.focus({ preventScroll: true });
    return undefined;
  }

  // Kept for the earlier entry point (smoke tests and older callers): opens the switcher list.
  function togglePillList() {
    pill?.querySelector('.switch')?.click();
  }

  async function choosePasskey(c) {
    const cur = inline;
    if (!cur || !c) return;
    inline = null;
    passkeyAnim('wait', texts.passkeyWait || 'Keevault …');
    try {
      const res = await call('cs:webauthnSelect', { requestId: cur.requestId, containerId: c.containerId, itemId: c.itemId, credentialId: c.credentialId });
      passkeyAnim('ok', texts.passkeyOk || 'Passkey');
      // Microsoft: signed in with Keevault's passkey – "Stay signed in?" that follows gets "No".
      if (MS_LOGIN_HOSTS.test(location.hostname)) markSignedIn();
      toPage({ id: cur.pageId, result: res.result });
    } catch (err) {
      passkeyAnim('hide');
      toPage({ id: cur.pageId, error: { name: 'NotAllowedError', message: err.message } });
    }
  }

  /** Saves the new passkey in the chosen vault; the result arrives as webauthn:result (success animation there). */
  async function savePasskey(containerId) {
    const cur = inline;
    if (!cur || !containerId) return;
    inline = null;
    modalRequests.set(cur.requestId, cur.pageId);
    pendingKinds.set(cur.requestId, 'create');
    passkeyAnim('wait', texts.passkeyWait || 'Keevault …');
    try {
      await call('cs:webauthnCreate', { requestId: cur.requestId, containerId });
    } catch (err) {
      modalRequests.delete(cur.requestId);
      pendingKinds.delete(cur.requestId);
      passkeyAnim('hide');
      toPage({ id: cur.pageId, error: { name: 'NotAllowedError', message: err.message } });
    }
  }

  /** "Other device": the browser's own passkey dialog takes over (phone, security key, Windows Hello). */
  function dismissPill() {
    const cur = inline;
    inline = null;
    hidePill();
    if (!cur) return;
    call('cs:webauthnAbort', { requestId: cur.requestId }).catch(() => {});
    toPage({ id: cur.pageId, fallback: true });
  }

  /** "Cancel": the website gets the usual "not allowed" answer. */
  function cancelPill() {
    const cur = inline;
    inline = null;
    hidePill();
    if (!cur) return;
    call('cs:webauthnAbort', { requestId: cur.requestId }).catch(() => {});
    toPage({ id: cur.pageId, error: { name: 'NotAllowedError', message: texts.cancel || 'Cancelled' } });
  }

  /** "Other options": the prompt window (unlock protected vaults, use another device). */
  async function openPromptWindow() {
    const cur = inline;
    inline = null;
    hidePill();
    if (!cur) return;
    try {
      const r = await call('cs:webauthnWindow', { requestId: cur.requestId });
      modalRequests.set(r.pending, cur.pageId);
      pendingKinds.set(r.pending, cur.kind === 'unlock' ? 'get' : cur.kind);
    } catch {
      toPage({ id: cur.pageId, fallback: true });
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.isTrusted && e.key === 'Escape' && inline) dismissPill();
  }, true);

  async function refreshConditional() {
    if (!conditional) return;
    const res = await call('cs:webauthnCandidates', { requestId: conditional.requestId }).catch(() => null);
    if (res && conditional) Object.assign(conditional, res);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!alive || sender.id !== chrome.runtime.id || !msg?.type) return undefined;
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
  // "Connect"/"Verbinden": Bastion's sign-in to a VM (a plain button, no form).
  const SUBMIT_HINT = /log ?in|sign ?in|anmeld|einlogg|weiter|next|continue|submit|register|registrier|speichern|save|ändern|change|connect|verbind/i;

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
    .banner input.q { width: 100%; margin: 6px 0 4px; padding: 6px 8px; border-radius: 6px; border: 1px solid #c4c9d4; font-size: 13px; background: #fff; color: inherit; outline: none; }
    .banner input.q:focus { border-color: #0f6cbd; box-shadow: 0 0 0 2px rgba(15,108,189,.18); }
    .ms-list { max-height: 264px; overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
    .entry-row { display: flex; align-items: center; gap: 6px; }
    .entry-row .entry { flex: 1; min-width: 0; }
    .entry-row button.b { flex: none; padding: 4px 8px; font-size: 12px; }
    .ms-none { padding: 8px; }
    [hidden] { display: none !important; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    button.b { border: 1px solid #c4c9d4; background: #fff; color: #1b1b1f; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    button.b.primary { background: #0f6cbd; border-color: #0f6cbd; color: #fff; }
    button.x { position: absolute; top: 8px; right: 8px; border: 0; background: none; font-size: 18px; cursor: pointer; color: #5b6170; }
    .logo { width: 18px; height: 18px; border-radius: 5px; background: #0f6cbd; display: inline-grid; place-items: center; color: #fff; font-size: 11px; }
    /* Keevault key tag (passkeys): hangs top center from the browser frame, drops in and swings out; symmetric layout. */
    .kvtag { --kv: #0f6cbd; --kv-soft: #e3effa; --ok: #1f9d55; --line: #dde2ec; --muted: #5d6779; --surface: #fff; --ink: #141a26;
      position: fixed; top: 12px; left: 0; right: 0; margin: 0 auto; z-index: 2147483647; width: 268px; box-sizing: border-box;
      display: grid; gap: 10px; justify-items: center; text-align: center; padding: 18px 16px 12px;
      background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 18px; font-size: 13px;
      box-shadow: 0 18px 40px rgba(15,108,189,.18), 0 2px 8px rgba(20,26,38,.10);
      transform-origin: 50% -12px; animation: kvt-drop .6s cubic-bezier(.3,1.4,.5,1) both, kvt-swing 1.5s ease-in-out .6s; }
    .kvtag::before { content: ""; position: absolute; top: -9px; left: calc(50% - 8px); width: 16px; height: 16px; background: var(--surface);
      border-left: 1px solid var(--line); border-top: 1px solid var(--line); transform: rotate(45deg); border-radius: 3px 0 0 0; }
    .kvtag.hide { animation: kvt-away .35s ease-in forwards; }
    .kvtag.shake { animation: kvt-shake .35s ease; }
    .kvtag .badge { position: relative; width: 56px; height: 56px; display: grid; place-items: center; filter: drop-shadow(0 6px 14px rgba(15,108,189,.28)); }
    .kvtag .logo { width: 56px; height: 56px; display: block; overflow: hidden; border-radius: 14px; }
    .kvtag .logo .sweep { transform: translateX(-30px); }
    .kvtag .lock { position: absolute; right: -6px; bottom: -6px; font-size: 15px; line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,.25)); }
    .kvtag .shield { width: 30px; height: 30px; display: block; }
    .kvtag .shield .fill { fill: var(--kv); opacity: .14; }
    .kvtag .shield .outline { fill: none; stroke: var(--kv); stroke-width: 2; stroke-linejoin: round; }
    .kvtag .shield .lockbody { fill: var(--kv); }
    .kvtag .shield .lockarc { fill: none; stroke: var(--kv); stroke-width: 1.6; }
    .kvtag .stamp { position: absolute; left: calc(50% - 11px); bottom: -11px; width: 22px; height: 22px; border-radius: 50%; background: var(--ok); color: #fff;
      display: grid; place-items: center; font-size: 12px; font-weight: 800; border: 2px solid var(--surface); opacity: 0; }
    .kvtag .title { font-weight: 700; font-size: 14px; }
    .kvtag .head { display: grid; gap: 2px; }
    .kvtag .sub { color: var(--muted); font-size: 12px; }
    .kvtag .switch { width: 100%; display: grid; grid-template-columns: 14px 1fr 14px; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; background: var(--surface); color: var(--ink); cursor: pointer; text-align: center; font: inherit; }
    .kvtag .switch::before { content: ""; }
    .kvtag .switch:hover, .kvtag .switch.open { border-color: var(--kv); }
    .kvtag .who { flex: 1; min-width: 0; display: grid; }
    .kvtag .who .main, .kvtag .opt .main { font-weight: 700; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kvtag .who .sub, .kvtag .opt .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kvtag .chev { color: var(--muted); font-size: 12px; }
    .kvtag [hidden] { display: none !important; }
    .kvtag .list { width: 100%; display: grid; gap: 2px; border: 1px solid var(--line); border-radius: 12px; padding: 4px; max-height: 220px; overflow: auto; }
    .kvtag .opt { display: grid; text-align: center; border: 0; border-radius: 8px; background: none; color: var(--ink); padding: 7px 9px; cursor: pointer; font: inherit; }
    .kvtag .opt:hover, .kvtag .opt.on { background: var(--kv-soft); }
    .kvtag .opt-window .main { font-weight: 600; color: var(--muted); }
    .kvtag .primary { width: 100%; border: 0; border-radius: 12px; background: var(--kv); color: #fff; font: inherit; font-weight: 700; font-size: 14px; padding: 10px; cursor: pointer; }
    .kvtag .primary:hover { filter: brightness(1.08); }
    .kvtag .primary:disabled { opacity: .6; cursor: default; }
    .kvtag input.pin { width: 140px; text-align: center; border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; font: inherit; font-size: 15px; letter-spacing: .3em; background: var(--surface); color: var(--ink); }
    .kvtag input.pin:focus, .kvtag button:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(15,108,189,.28); }
    .kvtag .links { display: flex; gap: 16px; justify-content: center; }
    .kvtag .link { border: 0; background: none; color: var(--muted); font: inherit; font-size: 12px; padding: 2px 4px; cursor: pointer; }
    .kvtag .link:hover { color: var(--kv); }
    .kvtag .note { font-weight: 700; font-size: 13px; }
    .kvtag.anim { width: 220px; padding-bottom: 16px; }
    .kvtag.wait .logo .sh { animation: kvt-breathe 1.2s ease-in-out infinite; }
    .kvtag.wait .logo .sweep { animation: kvt-sweep 1.4s ease-in-out infinite; }
    
    .kvtag.ok .stamp { animation: kvt-stamp .4s cubic-bezier(.3,1.6,.5,1) forwards; }
    @keyframes kvt-drop { from { transform: translateY(-120%); opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes kvt-swing { 0% { transform: rotate(0); } 25% { transform: rotate(2.5deg); } 55% { transform: rotate(-1.6deg); } 80% { transform: rotate(.8deg); } 100% { transform: rotate(0); } }
    @keyframes kvt-away { to { transform: translateY(-110%); opacity: 0; } }
    @keyframes kvt-shake { 0%, 100% { transform: none; } 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
    @keyframes kvt-breathe { 50% { opacity: .55; } }
    @keyframes kvt-sweep { from { transform: translateX(-30px); } to { transform: translateX(70px); } }
    @keyframes kvt-draw { 0% { stroke-dashoffset: 80; } 60% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -80; } }
    @keyframes kvt-stamp { from { transform: scale(2.2) rotate(-20deg); opacity: 0; } to { transform: none; opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .kvtag, .kvtag * { animation-duration: .01s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; } }
    @media (prefers-color-scheme: dark) {
      .menu, .banner { background: #23252b; color: #eceef2; border-color: #3a3d46; }
      .kvtag { --kv: #5aa6ff; --kv-soft: #17304d; --ok: #4cc38a; --line: #2a3344; --muted: #9aa6ba; --surface: #171d28; --ink: #e8edf5; }
      .entry:hover, .entry:focus { background: #2f3440; }
      .head, .s, .banner .user, button.x { color: #a6abb8; }
      button.b { background: #2b2e36; color: #eceef2; border-color: #464a55; }
      .banner select, .banner input.q { background: #2b2e36; color: #eceef2; border-color: #464a55; }
    }`;

  let host = null;
  let root = null;
  let pkTimer = null;
  const pendingKinds = new Map(); // extension request id → 'get' | 'create'

  /**
   * The key tag's moments: 'wait' (the shield outline draws itself), 'ok' (the shield fills, a check is stamped,
   * then the tag swings up and away), 'hide'. Continues in the open tag when there is one, otherwise a small tag
   * appears (e.g. after the prompt window or the field menu).
   */
  function passkeyAnim(state, text) {
    clearTimeout(pkTimer);
    if (state === 'hide') {
      if (pill?.classList.contains('anim')) hidePill(); // only the animation, never a tag waiting for a choice
      return;
    }
    if (!pill || !pill.isConnected) {
      pill = el('div', 'kvtag');
      pill.setAttribute('role', 'status');
      ui().append(pill);
    }
    let note = pill.querySelector('.note');
    if (!pill.classList.contains('anim')) {
      // Swap the controls for badge + one line of text, the tag itself stays where it hangs.
      pill.classList.add('anim');
      pill.replaceChildren(shieldBadge(), note = el('div', 'note'));
    }
    pill.classList.toggle('wait', state === 'wait');
    pill.classList.toggle('ok', state === 'ok');
    note.textContent = text || '';
    if (state === 'ok') pkTimer = setTimeout(() => passkeyAnim('hide'), 1600);
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
  let engaged = null; // the field the user reached or operated by real input
  let reachedBy = null; // what the last real input may have moved the focus to: the pressed element or 'Tab'
  let reachedAt = 0;
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
    // Microsoft's sign-in page (#334): a Microsoft account from the field menu signs in step by step like the bar –
    // name, passkey (if the account has one) or password, one-time code. A refusal ends here: nothing is filled in.
    if (isTop && MS_LOGIN_HOSTS.test(location.hostname)) {
      const ids = { containerId: entry.containerId, id: entry.id };
      const job = await call('cs:msAccount', ids).catch(() => null);
      if (job) runSignIn(job, () => call('cs:msAccount', ids).catch(() => null));
      return;
    }
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

  // The menu names entries, so only the user's own input at the field opens it. A script's focus() also gives a trusted
  // focusin, and navigator.userActivation would count a click anywhere on the page.
  const engage = (e) => { engaged = e.target; onFocus(e); };
  document.addEventListener('pointerdown', (e) => { if (e.isTrusted) { reachedBy = e.target; reachedAt = Date.now(); } }, true);
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLInputElement) lastFocused = e.target;
    const reached = e.isTrusted && Date.now() - reachedAt < 500 && (reachedBy === e.target || reachedBy === 'Tab');
    reachedBy = null; // one input opens once
    if (reached) engage(e);
  }, true);
  document.addEventListener('click', (e) => {
    if (e.isTrusted && e.target instanceof HTMLInputElement && e.target === document.activeElement && !menu) engage(e);
  }, true);
  document.addEventListener('focusout', () => {
    engaged = null;
    setTimeout(() => { if (menu && document.activeElement !== anchor) hideMenu(); }, 150);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu) hideMenu();
    if (!e.isTrusted) return;
    if (e.key === 'Tab') { reachedBy = 'Tab'; reachedAt = Date.now(); }
    // Autofocused field: the first typed key or arrow down. After Escape further typing stays quiet.
    else if ((e.key.length === 1 || e.key === 'ArrowDown') && e.target === document.activeElement && e.target !== engaged && !menu) engage(e);
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
    const bastion = info.action === 'bastion';
    title.append(el('span', 'logo', 'K'), document.createTextNode(bastion ? texts.bastionTitle : info.action === 'update' ? texts.updateTitle : texts.saveTitle));
    const desc = el('div', '', bastion ? `VM „${info.title}“` : info.action === 'update' ? `„${info.title}“ (${info.host})` : info.host);
    const user = el('div', 'user', info.username || texts.noUser);
    banner.append(close, title, desc, user);
    let select = null;
    let folder = null;
    if (bastion) banner.append(el('div', 's', info.existing ? texts.bastionExisting : texts.bastionHint));
    if ((info.action === 'save' || (bastion && !info.existing)) && info.containers.length > 1) {
      select = el('select');
      for (const c of info.containers) {
        const o = el('option', '', c.name);
        o.value = c.id;
        o.selected = c.id === info.defaultContainer;
        select.append(o);
      }
      banner.append(select);
    }
    if (bastion && !info.existing) {
      folder = el('input', 'q');
      folder.placeholder = texts.folderPlaceholder;
      banner.append(folder);
    }
    const row = el('div', 'row');
    const save = el('button', 'b primary', info.action === 'update' ? texts.update : texts.save);
    save.addEventListener('click', async (e) => {
      if (!e.isTrusted) return;
      save.disabled = true;
      try {
        await call('cs:saveCaptured', { containerId: select?.value || info.defaultContainer, folder: folder?.value || '' });
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
    if (info.action === 'save' || bastion) row.append(never);
    banner.append(row);
    ui().append(banner);
  }

  // ------------------------------------------------------------ one-click sign-in (admin tools, Microsoft sign-in)

  // Started in the app (admin center or Bastion), or chosen in the bar on the Microsoft sign-in page: the Microsoft
  // sign-in is walked through step by step – account tile or name, password, one-time code –, Bastion's form is
  // filled. Only on the sign-in hosts.
  const SIGN_IN_HOSTS = /(^|\.)(login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com|bastion\.azure\.com|portal\.azure\.net)$/i;
  const MS_LOGIN_HOSTS = /(^|\.)(login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com)$/i;

  async function initSignIn() {
    if (isTop && MS_LOGIN_HOSTS.test(location.hostname)) declineStaySignedIn();
    // Signing out: an open one-click sign-in ends and the remembered account no longer starts by itself – otherwise
    // Microsoft's redirect back to its sign-in page would sign the same account straight in again.
    if (MS_LOGIN_HOSTS.test(location.hostname) && SIGN_OUT_PATH.test(location.pathname)) return signedOut();
    const job = await call('cs:signIn').catch(() => null);
    if (job) return runSignIn(job, () => call('cs:signIn').catch(() => null));
    if (isTop && MS_LOGIN_HOSTS.test(location.hostname)) offerMicrosoftAccounts();
    if (BASTION_FORM_HOSTS.test(location.hostname)) offerBastionAccounts();
    return undefined;
  }

  // Bastion's own sign-in form to the VM: in the portal (its page or the blade frame) or on a shareable link page.
  // On portal.azure.com the service worker only answers on a VM's Bastion blade.
  const BASTION_FORM_HOSTS = /(^|\.)(bastion\.azure\.com|portal\.azure\.net|portal\.azure\.com)$/i;

  /**
   * Bastion sign-in opened in the browser (not from the app, #27, #306): a bar with the logins; the chosen one is filled
   * in and connected, "Save" next to it only keeps the VM as an asset (linked to that login, the Microsoft sign-in and
   * tenant found by themselves) – before signing in. The portal changes pages without loading: the form is watched
   * for as long as the page lives, once per address.
   */
  function offerBastionAccounts() {
    let shownFor = '';
    let bar = null;
    const look = () => {
      if (!alive) return;
      if (shownFor && shownFor !== location.href) { bar?.remove(); shownFor = ''; }
      const fields = loginFields(document);
      if (!shownFor && fields.password && usable(fields.password)) { shownFor = location.href; show(fields); }
      setTimeout(look, 1000);
    };
    const show = async (fields) => {
      const offer = await call('cs:bastionAccounts').catch(() => null);
      if (!offer?.accounts?.length) return;
      if (offer.ui) texts = offer.ui;
      const fill = (text, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.replace('{' + k + '}', v), text || '');
      bar?.remove();
      bar = el('div', 'banner bastion-pick');
      const close = el('button', 'x', '×');
      close.title = texts.close || '';
      close.addEventListener('click', (e) => { if (e.isTrusted) bar.remove(); });
      const title = el('div', 'title');
      title.append(el('span', 'logo', 'K'), document.createTextNode(texts.bastionPickTitle));
      const save = el('input');
      save.type = 'checkbox';
      save.checked = !offer.linkedKey;
      const saveLabel = el('label', 's');
      saveLabel.append(save, document.createTextNode(' ' + texts.bastionSave));
      const start = async (a) => {
        const r = await call('cs:bastionAccount', { containerId: a.containerId, id: a.id, save: save.checked }).catch(() => null);
        if (!r?.job) return;
        bar.replaceChildren(title, el('div', 'user', fill(texts.bastionConnecting, { name: r.job.username || a.title })));
        setTimeout(() => bar.remove(), 4000);
        const f = loginFields(document);
        if (f.username && r.job.username) setValue(f.username, r.job.username);
        if (f.password) setValue(f.password, r.job.password);
        pressConnect(f.password || fields.password);
      };
      // "Save" only: the asset with this account, without signing in (#306).
      const saveOnly = async (a) => {
        const r = await call('cs:bastionAccount', { containerId: a.containerId, id: a.id, save: true, signIn: false }).catch(() => null);
        if (!r?.saved) return;
        bar.replaceChildren(close, title, el('div', 'user', fill(texts.bastionSaved, { title: r.saved.title })));
        setTimeout(() => bar.remove(), 4000);
      };
      const entries = offer.accounts.map((a) => {
        const b = el('button', 'entry');
        const text = el('div', 'txt');
        text.append(el('div', 't', a.title), el('div', 's', [a.username, a.container].filter(Boolean).join(' · ')));
        b.append(el('span', 'avatar', (a.title || '?').slice(0, 1).toUpperCase()), text);
        b.addEventListener('click', (e) => { if (e.isTrusted) start(a); });
        const keep = el('button', 'b save-only', texts.bastionSaveOnly);
        keep.title = texts.bastionSaveOnlyHint || '';
        keep.addEventListener('click', (e) => { if (e.isTrusted) saveOnly(a); });
        const row = el('div', 'entry-row');
        row.append(b, keep);
        row.dataset.q = [a.title, a.username, a.container].join(' ').toLowerCase();
        return row;
      });
      const box = el('div', 'ms-list');
      box.append(...entries);
      const none = el('div', 's ms-none', texts.msNone);
      none.hidden = true;
      const q = el('input', 'q');
      q.type = 'search';
      q.placeholder = texts.msSearch;
      q.setAttribute('aria-label', texts.msSearch);
      q.addEventListener('input', () => {
        const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        for (const b of entries) b.hidden = !words.every((w) => b.dataset.q.includes(w));
        none.hidden = entries.some((b) => !b.hidden);
      });
      q.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !e.isTrusted) return;
        e.preventDefault();
        entries.find((b) => !b.hidden)?.querySelector('.entry')?.click();
      });
      box.append(none);
      const parts = [close, title, el('div', 'user', `VM „${offer.vmName}“`)];
      if (offer.asset) parts.push(el('div', 's', fill(texts.bastionAsset, { title: offer.asset.title, vault: offer.asset.container })));
      bar.append(...parts, q, box, saveLabel);
      ui().append(bar);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', look, { once: true });
    else look();
  }

  // "Stay signed in?" after a sign-in Keevault did in this tab (last 2 minutes): answered with "No" – nothing stays signed
  // in on the browser by itself. Sign-ins done by hand keep the question. Also kept by the service worker: a passkey
  // sign-in runs through login.microsoft.com, the question comes on login.microsoftonline.com (another origin).
  const markSignedIn = () => {
    try { sessionStorage.setItem('kvMsSignedInAt', String(Date.now())); } catch { /* storage blocked */ }
    call('cs:msMark').catch(() => {});
  };
  async function declineStaySignedIn() {
    let recent = false;
    try { recent = Date.now() - Number(sessionStorage.getItem('kvMsSignedInAt') || 0) < 120_000; } catch { /* storage blocked */ }
    if (!recent) recent = await call('cs:msRecent').catch(() => false);
    if (!recent) return;
    const started = Date.now();
    const look = () => {
      if (!alive || Date.now() - started > 20_000) return;
      const kmsi = document.querySelector('#KmsiCheckboxField, input[name="DontShowAgain"], #KmsiDescription, [data-testid="kmsiVideo"]');
      const no = document.querySelector('#idBtn_Back') || document.querySelector('#declineButton');
      if (kmsi && no && !no.disabled && visible(no)) {
        try { sessionStorage.removeItem('kvMsSignedInAt'); } catch { /* storage blocked */ }
        call('cs:msMark', { clear: true }).catch(() => {});
        no.click();
        return;
      }
      setTimeout(look, 400);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', look, { once: true });
    else look();
  }

  const visibleInput = (sel) => { const e = document.querySelector(sel); return e && usable(e) ? e : null; };
  // The page asks for an account (name field, account tiles) or a password – only then the bar makes sense.
  // Signing out (Microsoft's "Which account do you want to sign out of?") is not a sign-in: no bar, no auto sign-in.
  const SIGN_OUT_PATH = /\/(oauth2\/(v2\.0\/)?logout|logout\.srf|logoutsession|signout)/i;
  const SIGN_OUT_TEXT = /abmelden m(ö|oe)chten|abgemeldet|sign out of|signed out|you have signed out/i;
  // Microsoft's switch from the password to a passkey ("face, fingerprint, PIN or security key").
  const FIDO_TEXT = /gesicht.*fingerabdruck|sicherheitsschl(ü|ue)ssel|face.*fingerprint|security key|passkey|hauptschl(ü|ue)ssel/i;
  const signingOut = () => SIGN_OUT_PATH.test(location.pathname)
    || SIGN_OUT_TEXT.test(document.querySelector('#loginHeader, [role=heading], .title, h1')?.textContent || '');
  const signedOut = () => call('cs:msSignedOut').catch(() => {});
  const asksForAccount = () => !!(visibleInput('input[name=loginfmt]') || visibleInput('input[name=passwd]') || document.querySelector('[data-test-id] [role=button], #tilesHolder [data-test-id]'));
  // Started only here: everything it uses is defined above.
  if (SIGN_IN_HOSTS.test(location.hostname)) initSignIn();
  // The Azure portal itself: Bastion's form on a VM's blade (the service worker checks the address).
  else if (/(^|\.)portal\.azure\.com$/i.test(location.hostname)) offerBastionAccounts();

  function runSignIn(job, fresh, { onDone = () => call('cs:signInDone').catch(() => {}) } = {}) {
    const started = Date.now();
    const done = new Set();
    let busy = false;
    let timer = null;
    let observer = null;
    const stop = () => { observer?.disconnect(); clearTimeout(timer); };
    const next = () => {
      // Never "Sign in" with an empty password field (Microsoft only answers "Enter your password").
      const pwField = visibleInput('input[name=passwd]');
      if (pwField && !pwField.value) return;
      const b = document.querySelector('#idSIButton9') || document.querySelector('input[type=submit], button[type=submit]');
      if (b && !b.disabled) b.click();
    };
    // Account with a passkey (or without a password): the passkey is used, the password only when Microsoft offers no
    // passkey on its password page within a moment.
    const passkeyFirst = job.mode === 'microsoft' && (job.passkey || !job.password);
    let passwordPageAt = 0;
    const step = async () => {
      if (busy || !alive) return;
      if (Date.now() - started > 120_000) return stop();
      // The page turned out to be a sign-out (only recognisable by its heading): nothing is filled in here.
      if (MS_LOGIN_HOSTS.test(location.hostname) && signingOut()) { stop(); signedOut(); return; }
      busy = true;
      try {
        if (job.mode === 'microsoft') {
          const name = job.username.toLowerCase();
          const tile = name && [...document.querySelectorAll('[data-test-id]')].find((e) => (e.getAttribute('data-test-id') || '').toLowerCase() === name);
          if (tile && !done.has('tile')) { done.add('tile'); tile.click(); return; }
          // "Pick an account" without this account: "Use another account" – never one of the other tiles.
          const other = !tile && document.querySelector('#otherTile, [data-test-id=otherTile]');
          if (other && visible(other) && !done.has('other')) { done.add('other'); other.click(); return; }
          const user = visibleInput('input[name=loginfmt]');
          if (user && job.username && !done.has('user')) { done.add('user'); setValue(user, job.username); next(); return; }
          const pw = visibleInput('input[name=passwd]');
          // Passkey first: Microsoft shows its password page anyway – switch to "face, fingerprint, PIN or security key"
          // (directly or through "Other ways to sign in"); the passkey prompt then takes this account's passkey by
          // itself. The job stays open (it runs out by itself): the passkey request asks for it.
          if (pw && passkeyFirst && !done.has('nofido')) {
            const fido = document.querySelector('#idA_PWD_SwitchToFido')
              || [...document.querySelectorAll('a, button, [role=button], [role=link]')].find((e) => FIDO_TEXT.test(e.textContent || '') && visible(e));
            if (fido && visible(fido) && !done.has('fido')) { done.add('fido'); markSignedIn(); fido.click(); stop(); declineStaySignedIn(); return; }
            const picker = document.querySelector('#idA_PWD_SwitchToCredPicker');
            if (!fido && picker && visible(picker) && !done.has('picker')) { done.add('picker'); picker.click(); return; }
            // No passkey way on this page: after a moment the password (if there is one).
            if (!fido && !picker && job.password) {
              passwordPageAt ||= Date.now();
              if (Date.now() - passwordPageAt < 1500) { setTimeout(schedule, 500); return; }
              done.add('nofido');
            }
          }
          if (pw && job.password && !done.has('pw') && (!passkeyFirst || done.has('nofido'))) {
            done.add('pw');
            setValue(pw, job.password);
            markSignedIn();
            next();
            // Without a one-time code this was the last step: the sign-in is used up (no second automatic sign-in).
            if (!job.totp) { onDone(); stop(); declineStaySignedIn(); }
            return;
          }
          // "Other ways to sign in" list: the passkey option.
          if (passkeyFirst && done.has('picker') && !done.has('fido')) {
            const option = [...document.querySelectorAll('[role=button], [role=link], button, a, .tile')].find((e) => FIDO_TEXT.test(e.textContent || '') && visible(e));
            if (option) { done.add('fido'); markSignedIn(); option.click(); stop(); declineStaySignedIn(); return; }
          }
          const otc = visibleInput('input[name=otc]');
          if (otc && !done.has('otc')) {
            // Ask again: the code has to be current when it is typed in.
            const current = await fresh();
            if (current?.totp) { done.add('otc'); setValue(otc, current.totp); markSignedIn(); next(); onDone(); stop(); declineStaySignedIn(); }
            return;
          }
        } else if (!done.has('form')) {
          const fields = loginFields(document);
          if (fields.password && job.password) {
            done.add('form');
            if (fields.username && job.username) setValue(fields.username, job.username);
            setValue(fields.password, job.password);
            // Bastion (#31): also press "Connect" once the page took the values (React enables the button late).
            if (job.mode === 'bastion') pressConnect(fields.password, { closeTab: true });
            onDone();
            stop();
          }
        }
      } finally {
        busy = false;
      }
      return undefined;
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(step, 350); };
    const begin = () => {
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
      schedule();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
    else begin();
  }

  // Bastion's button: "Connect" in the portal blade, "Verbinden" in German, "Login"/"Anmelden" on shareable links.
  const CONNECT_TEXT = /^(connect|verbinden|login|log in|anmelden|sign in)$/i;
  /**
   * After Bastion's form was filled: its connect button, as soon as it is enabled (up to 10 s). closeTab: started in the
   * app ("Bastion") – the tab with the form closes once Bastion opened the session in a new one; signed in from the
   * bar in the browser the tab stays (#306).
   */
  function pressConnect(field, { closeTab = false } = {}) {
    const started = Date.now();
    const find = () => {
      const scope = field?.form || document;
      const buttons = [...scope.querySelectorAll('button, input[type=submit], [role=button]')];
      return buttons.find((b) => CONNECT_TEXT.test((b.textContent || b.value || '').trim()) && visible(b))
        || buttons.find((b) => (b.type === 'submit') && visible(b));
    };
    const tryPress = () => {
      if (!alive || Date.now() - started > 10_000) return;
      const b = find();
      if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') {
        // The service worker closes this tab once Bastion opened the session in a new one (#33) – app start only.
        if (closeTab) call('cs:bastionConnected').catch(() => {});
        b.click();
        return;
      }
      setTimeout(tryPress, 400);
    };
    setTimeout(tryPress, 500);
  }

  /** Microsoft sign-in page: bar with the Microsoft accounts; a remembered one starts by itself after 3 seconds. */
  function offerMicrosoftAccounts() {
    let waited = 0;
    const whenAsked = () => {
      if (!alive) return;
      if (signingOut()) { signedOut(); return; }
      if (asksForAccount()) { show(); return; }
      if ((waited += 500) < 15_000) setTimeout(whenAsked, 500);
    };
    let msBanner = null;
    const show = async () => {
      const offer = await call('cs:msAccounts').catch(() => null);
      if (!offer?.accounts?.length) return;
      if (offer.ui) texts = offer.ui;
      const fill = (text, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.replace('{' + k + '}', v), text || '');
      msBanner?.remove();
      msBanner = el('div', 'banner');
      const close = el('button', 'x', '×');
      close.title = texts.close || '';
      close.addEventListener('click', (e) => { if (e.isTrusted) msBanner.remove(); });
      const title = el('div', 'title');
      title.append(el('span', 'logo', 'K'), document.createTextNode(texts.msTitle));
      msBanner.append(close, title);
      // Attached first: the countdown below only runs while the bar is on the page.
      ui().append(msBanner);
      const start = async (account, remember) => {
        if (remember) await call('cs:msRemember', { key: account.key }).catch(() => {});
        const job = await call('cs:msAccount', { containerId: account.containerId, id: account.id }).catch(() => null);
        if (!job) return;
        msBanner.replaceChildren(title, el('div', 'user', fill(texts.msSigningIn, { name: account.username || account.title })));
        setTimeout(() => msBanner?.remove(), 4000);
        runSignIn(job, () => call('cs:msAccount', { containerId: account.containerId, id: account.id }).catch(() => null));
      };
      const list = () => {
        const remember = el('input');
        remember.type = 'checkbox';
        const label = el('label', 's');
        label.append(remember, document.createTextNode(' ' + texts.msRemember));
        const entries = offer.accounts.map((a) => {
          const b = el('button', 'entry');
          const text = el('div', 'txt');
          text.append(el('div', 't', a.title), el('div', 's', [a.username, a.container].filter(Boolean).join(' · ')));
          b.append(el('span', 'avatar', (a.title || '?').slice(0, 1).toUpperCase()), text);
          b.addEventListener('click', (e) => { if (e.isTrusted) start(a, remember.checked); });
          b.dataset.q = [a.title, a.username, a.container].join(' ').toLowerCase();
          return b;
        });
        // More than one account: a search field above a scrolling list (title, user name, vault); Enter takes the first hit.
        const box = el('div', 'ms-list');
        box.append(...entries);
        const parts = [close, title];
        if (entries.length > 1) {
          const none = el('div', 's ms-none', texts.msNone);
          none.hidden = true;
          const q = el('input', 'q');
          q.type = 'search';
          q.placeholder = texts.msSearch;
          q.setAttribute('aria-label', texts.msSearch);
          q.addEventListener('input', () => {
            const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
            for (const b of entries) b.hidden = !words.every((w) => b.dataset.q.includes(w));
            none.hidden = entries.some((b) => !b.hidden);
          });
          q.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !e.isTrusted) return;
            e.preventDefault();
            entries.find((b) => !b.hidden)?.click();
          });
          box.append(none);
          parts.push(q);
        }
        msBanner.replaceChildren(...parts, box, label);
        if (offer.defaultKey) {
          const forget = el('button', 'b', texts.msForget);
          forget.addEventListener('click', (e) => {
            if (!e.isTrusted) return;
            call('cs:msRemember', { key: null }).catch(() => {});
            offer.defaultKey = null;
            forget.remove();
          });
          msBanner.append(el('div', 'row'), forget);
        }
      };
      // The remembered account signs in by itself once per tab (10 minutes); after that – e.g. "Use another account" on
      // Microsoft's page – the list is offered, so the user can be switched.
      let autoRan = false;
      try { autoRan = Date.now() - Number(sessionStorage.getItem('kvMsAutoAt') || 0) < 10 * 60_000; } catch { /* storage blocked */ }
      // After signing out the remembered account waits until an account is chosen again (cs:msSignedOut).
      const remembered = !autoRan && !offer.paused && offer.accounts.find((a) => a.key === offer.defaultKey);
      if (remembered) {
        try { sessionStorage.setItem('kvMsAutoAt', String(Date.now())); } catch { /* storage blocked */ }
        // Remembered account: a short countdown, then it signs in – "Other account" stops it.
        let seconds = 3;
        const info = el('div', 'user');
        const other = el('button', 'b', texts.msOther);
        const row = el('div', 'row');
        row.append(other);
        msBanner.append(info, row);
        const tick = () => {
          if (!msBanner?.isConnected) return;
          if (seconds === 0) { start(remembered, false); return; }
          info.textContent = fill(texts.msAuto, { name: remembered.username || remembered.title, seconds });
          seconds -= 1;
          countdown = setTimeout(tick, 1000);
        };
        let countdown = null;
        other.addEventListener('click', (e) => { if (!e.isTrusted) return; clearTimeout(countdown); list(); });
        tick();
      } else list();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', whenAsked, { once: true });
    else whenAsked();
  }

  if (isTop) {
    const checkPending = () => call('cs:pending').then(showSaveBanner).catch(() => {});
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkPending, { once: true });
    else checkPending();
  }
})();
