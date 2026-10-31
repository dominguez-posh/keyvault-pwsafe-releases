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
          if (document.activeElement instanceof HTMLInputElement) onFocus({ target: document.activeElement });
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
  const shieldBadge = (locked = false) => {
    const b = el('div', 'badge');
    b.innerHTML = `<svg class="shield" viewBox="0 0 24 24"><path class="fill" d="${SHIELD_PATH}"/><path class="outline" d="${SHIELD_PATH}"/>${locked ? '<rect class="lockbody" x="9" y="11" width="6" height="5" rx="1"/><path class="lockarc" d="M10 11V9.5a2 2 0 0 1 4 0V11"/>' : ''}</svg>`;
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
    /* Keevault key tag (passkeys): hangs below the toolbar icon, notch pointing at it, drops in and swings out. */
    .kvtag { --kv: #0f6cbd; --kv-soft: #e3effa; --ok: #1f9d55; --line: #dde2ec; --muted: #5d6779; --surface: #fff; --ink: #141a26;
      position: fixed; top: 10px; right: 18px; z-index: 2147483647; width: 268px; box-sizing: border-box;
      display: grid; gap: 10px; justify-items: center; text-align: center; padding: 18px 16px 12px;
      background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 18px; font-size: 13px;
      box-shadow: 0 18px 40px rgba(15,108,189,.18), 0 2px 8px rgba(20,26,38,.10);
      transform-origin: calc(100% - 30px) -10px; animation: kvt-drop .6s cubic-bezier(.3,1.4,.5,1) both, kvt-swing 1.5s ease-in-out .6s; }
    .kvtag::before { content: ""; position: absolute; top: -9px; right: 24px; width: 16px; height: 16px; background: var(--surface);
      border-left: 1px solid var(--line); border-top: 1px solid var(--line); transform: rotate(45deg); border-radius: 3px 0 0 0; }
    .kvtag.hide { animation: kvt-away .35s ease-in forwards; }
    .kvtag.shake { animation: kvt-shake .35s ease; }
    .kvtag .badge { position: relative; width: 52px; height: 52px; border-radius: 16px; display: grid; place-items: center; background: var(--kv-soft); }
    .kvtag .shield { width: 30px; height: 30px; display: block; }
    .kvtag .shield .fill { fill: var(--kv); opacity: .14; }
    .kvtag .shield .outline { fill: none; stroke: var(--kv); stroke-width: 2; stroke-linejoin: round; }
    .kvtag .shield .lockbody { fill: var(--kv); }
    .kvtag .shield .lockarc { fill: none; stroke: var(--kv); stroke-width: 1.6; }
    .kvtag .stamp { position: absolute; right: -6px; bottom: -6px; width: 22px; height: 22px; border-radius: 50%; background: var(--ok); color: #fff;
      display: grid; place-items: center; font-size: 12px; font-weight: 800; border: 2px solid var(--surface); opacity: 0; }
    .kvtag .title { font-weight: 700; font-size: 14px; }
    .kvtag .head { display: grid; gap: 2px; }
    .kvtag .sub { color: var(--muted); font-size: 12px; }
    .kvtag .switch { width: 100%; display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; background: var(--surface); color: var(--ink); cursor: pointer; text-align: left; font: inherit; }
    .kvtag .switch:hover, .kvtag .switch.open { border-color: var(--kv); }
    .kvtag .who { flex: 1; min-width: 0; display: grid; }
    .kvtag .who .main, .kvtag .opt .main { font-weight: 700; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kvtag .who .sub, .kvtag .opt .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kvtag .chev { color: var(--muted); font-size: 12px; }
    .kvtag [hidden] { display: none !important; }
    .kvtag .list { width: 100%; display: grid; gap: 2px; border: 1px solid var(--line); border-radius: 12px; padding: 4px; max-height: 220px; overflow: auto; }
    .kvtag .opt { display: grid; text-align: left; border: 0; border-radius: 8px; background: none; color: var(--ink); padding: 7px 9px; cursor: pointer; font: inherit; }
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
    .kvtag.wait .shield .outline { stroke-dasharray: 80; animation: kvt-draw 1.1s ease-in-out infinite; }
    .kvtag.ok .shield .fill { opacity: 1; transition: opacity .3s; }
    .kvtag.ok .stamp { animation: kvt-stamp .4s cubic-bezier(.3,1.6,.5,1) forwards; }
    @keyframes kvt-drop { from { transform: translateY(-120%) rotate(-5deg); opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes kvt-swing { 0% { transform: rotate(0); } 25% { transform: rotate(2.5deg); } 55% { transform: rotate(-1.6deg); } 80% { transform: rotate(.8deg); } 100% { transform: rotate(0); } }
    @keyframes kvt-away { to { transform: translateY(-110%) rotate(4deg); opacity: 0; } }
    @keyframes kvt-shake { 0%, 100% { transform: none; } 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
    @keyframes kvt-draw { 0% { stroke-dashoffset: 80; } 60% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -80; } }
    @keyframes kvt-stamp { from { transform: scale(2.2) rotate(-20deg); opacity: 0; } to { transform: none; opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .kvtag, .kvtag * { animation-duration: .01s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; } }
    @media (prefers-color-scheme: dark) {
      .menu, .banner { background: #23252b; color: #eceef2; border-color: #3a3d46; }
      .kvtag { --kv: #5aa6ff; --kv-soft: #17304d; --ok: #4cc38a; --line: #2a3344; --muted: #9aa6ba; --surface: #171d28; --ink: #e8edf5; }
      .entry:hover, .entry:focus { background: #2f3440; }
      .head, .s, .banner .user, button.x { color: #a6abb8; }
      button.b { background: #2b2e36; color: #eceef2; border-color: #464a55; }
      .banner select { background: #2b2e36; color: #eceef2; border-color: #464a55; }
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
