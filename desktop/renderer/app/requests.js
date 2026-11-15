// Requests that come to the window by themselves: passkey requests from Windows and questions of AI agents.

import { h, icon, toast, modal, passkeySuccess, showPinProblem } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { st } from './state.js';
import { HELLO_AGAIN, HELLO_ALLOW, HELLO_OR, autoHelloOnce, choiceName, field, notice } from './helpers.js';
import { FIELD_LABELS } from './file-vaults.js';
import { pinDialog } from './admin-mode.js';
import { openRequests, pinTyping } from './pin-typed.js';
import { focusField } from './focus.js';
import { reloadAll } from './shell.js';

/** #537 stage 4: what the passkey field asks once the master password is set up. */
// #537 2b: a confirmation for one use of an entry of the personal vault ("Immer bestätigen").
const confirmEach = (q) => /^(agent-)?confirm-each$/.test(q?.kind || '');
const proofPrompt = (q) => (confirmEach(q) ? t('Masterpasswort oder PIN eingeben, um diesen Zugriff zu bestätigen') : passkeyPinPrompt());
const passkeyPinPrompt = () => (st.unlock?.migrated ? t('Masterpasswort oder PIN eingeben, um diese Anmeldung zu erlauben') : t('App-PIN eingeben, um diese Anmeldung zu erlauben'));
// #537 live test (Lucas): with Windows Hello on, its own button (the recommended way); no "leave the field empty" any more.
const helloOr = () => (st.unlock?.hello ? h('p', { class: 'muted small hello-or' }, t(HELLO_OR)) : null);

const windowsDialogs = new Map(); // request id → close()
// #472 (review): every request dialog open in the window; Enter in a PIN field confirms only while it is the only one.
const pinRequests = openRequests();
// Konrad M1: at most one automatic Windows Hello for the questions within 60 s – a tool asking ten times gets one, the rest
// waits for a click (kvSmokeAgentAutoGap: the smoke run's shorter gap).
let lastQuestionAuto = 0;
const questionAutoGap = () => (typeof window.kvSmokeAgentAutoGap === 'number' ? window.kvSmokeAgentAutoGap : 60_000);
const onTop = (dialog) => [...document.querySelectorAll('dialog[open]')].at(-1) === dialog;
// Shown under the PIN field while more than one request is open: then only a click confirms.
const multiHint = (cls) => h('p', { class: `muted small ${cls}`, hidden: true }, t('Mehrere Anfragen offen – bestätige diese mit einem Klick.'));

/** Entries a request names (the browser move): own list, the titles as written (not translated), passkey entries marked, shortened with the total kept. */
function entriesList(entries) {
  if (!entries?.rows?.length) return null;
  const more = entries.total - entries.rows.length;
  return h('div', { class: 'q-entries' },
    h('div', { class: 'q-entries-count' }, t('{n} Einträge', { n: entries.total })),
    h('ul', { class: 'q-entries-list' }, ...entries.rows.map((e) => h('li', { class: 'q-entry', 'data-passkey': e.passkey ? '1' : '0' }, e.title, e.passkey ? h('span', { class: 'q-chip' }, t('Passkey')) : null))),
    more > 0 ? h('div', { class: 'q-entries-more' }, t('… und {n} weitere', { n: more })) : null);
}

export async function checkWindowsRequests() {
  let requests;
  try {
    requests = await call('windowsRequests');
  } catch {
    return;
  }
  const ids = new Set(requests.map((r) => r.id));
  for (const [id, close] of windowsDialogs) {
    if (!ids.has(id)) {
      close();
      windowsDialogs.delete(id);
    }
  }
  const lockedNotice = document.getElementById('windows-waiting');
  if (lockedNotice) lockedNotice.hidden = !requests.length;
  for (const r of requests) {
    if (r.locked || windowsDialogs.has(r.id)) continue;
    windowsDialogs.set(r.id, windowsDialog(r));
  }
}

/** #507: "Ablehnen" on the window's lock screen – refuses every Windows passkey request waiting behind the lock. */
export async function declineHeldWindowsRequests() {
  for (const r of await call('windowsRequests')) if (r.held) await call('windowsDecision', r.id, { cancel: true });
  await checkWindowsRequests();
}

/**
 * Question from the main process (AI agent wants to connect, read a password or change an entry): a dialog in the
 * app's style – agent badge, request, answers as buttons (the recommended one highlighted). Escape or × = cancel.
 */
export const openQuestions = new Map(); // id → close without answer
// MCP argument names that differ from the item fields (FIELD_LABELS below).
const AGENT_FIELD_ALIAS = { url: 'urls', generatePassword: 'password' };
// #368: "Allow" only works this long after the question appeared and after the last key press, so that someone who was
// typing for another program and keeps typing cannot answer it, not even with Tab and Enter. The same when the window
// comes to the front (#381): the click that activates it must not answer the question, so the delay starts again.
const CONFIRM_DELAY_MS = 1200;
// Questions still open: closing one starts the delay of those below it again, they come up under the mouse pointer.
const waitingQuestions = new Set();
export function questionDialog(q) {
  let answered = false;
  let close = () => {}; // set when the dialog exists (closes it and cleans up)
  const answer = (value) => {
    if (answered) return;
    answered = true;
    openQuestions.delete(q.id);
    call('answerQuestion', q.id, value).catch(() => {});
  };
  const icons = { 'agent-connect': 'link', 'agent-read': 'key', 'agent-write': 'edit', 'confirm-each': 'lock', 'agent-confirm-each': 'lock', held: 'lock' };
  // #368: the account choice starts without a selection, the user picks the account that is handed to the tool.
  let choice = q.filter ? null : q.choices?.[0]?.value || 'allow';
  let delayPassed = false;
  let delayTimer = null;
  let helloAllow = null; // #537 live test: "Mit Windows Hello erlauben" (set below when Hello is on)
  let tryAutoHello = () => {}; // #537 risk 3: Hello starts by itself once the request can be answered (set below)
  // During the delay the button only looks disabled: a really disabled button would lose the keyboard focus and get no
  // more key presses. Disabled for real only without a choice, where it can't have the focus.
  const updateAllow = () => {
    for (const b of [allow, helloAllow].filter(Boolean)) {
      b.disabled = choice === null || !!q.held; // #507: a held agent question is allowed only after the window's PIN
      b.setAttribute('aria-disabled', String(!delayPassed));
    }
  };
  const startDelay = () => {
    clearTimeout(delayTimer);
    delayPassed = false;
    updateAllow();
    delayTimer = setTimeout(() => { delayPassed = true; updateAllow(); }, CONFIRM_DELAY_MS);
  };
  // Every key starts the delay again, except a confirming key after the pause (space acts on key up, so it must not
  // start the delay on key down either).
  const onKey = (e) => {
    const confirming = ((e.target === allow || (helloAllow && e.target === helloAllow)) && (e.key === 'Enter' || e.key === ' '))
      || (q.filter && e.key === 'Enter' && e.target.matches?.('.q-option input:checked'));
    if (!delayPassed || !confirming) startDelay();
  };
  const options = (q.choices || []).map((c, i) => {
    const input = h('input', { type: 'radio', name: `q${q.id}`, value: c.value, checked: !q.filter && i === 0,
      onchange: () => { choice = c.value; updateAllow(); tryAutoHello(); },
      // Keyboard way through the account choice: Tab to the list, pick with arrows or space, then Enter.
      onkeydown: (e) => { if (q.filter && e.key === 'Enter' && input.checked) allow.click(); } });
    const label = h('label', { class: 'q-option' }, input,
      h('span', { class: 'q-option-text' }, h('span', { class: 'q-option-label' }, c.label), c.hint ? h('span', { class: 'q-option-hint' }, c.hint) : null));
    label.kvChoice = { ...c, input };
    return label;
  });
  // #339: search (title, user name, vault) and vault filter for the account choice – only with more than one account.
  // A hidden choice is never sent: filtering it away clears the selection (#368: no other account takes its place).
  // Enter in the search does nothing, otherwise text typed for another program could pick and hand over an account.
  let filterBar = null;
  let noHits = null;
  let applyFilter = () => {};
  if (q.filter && options.length > 1) {
    const vaults = [...new Set(options.map((o) => o.kvChoice.vault).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const search = h('input', { type: 'search', class: 'q-search', placeholder: t('Konto suchen …'), 'aria-label': t('Konto suchen …') });
    const vaultSelect = vaults.length > 1
      ? h('select', { class: 'q-vault', 'aria-label': t('Tresor') }, h('option', { value: '' }, t('Alle Tresore')), ...vaults.map((v) => h('option', { value: v }, v)))
      : null;
    noHits = h('p', { class: 'q-nohits muted', hidden: true }, t('Kein Konto passt zur Suche.'));
    applyFilter = () => {
      const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const vault = vaultSelect?.value || '';
      for (const o of options) {
        const c = o.kvChoice;
        o.hidden = !(words.every((w) => c.search.includes(w)) && (!vault || c.vault === vault));
      }
      const current = options.find((o) => o.kvChoice.value === choice);
      if (current?.hidden) {
        current.kvChoice.input.checked = false;
        choice = null;
        updateAllow();
      }
      noHits.hidden = options.some((o) => !o.hidden);
    };
    search.addEventListener('input', applyFilter);
    vaultSelect?.addEventListener('change', applyFilter);
    filterBar = h('div', { class: 'q-filter' }, h('span', { class: 'q-search-wrap' }, icon('search', 14), search), vaultSelect);
  }
  // #370: old and new value of what the agent wants to change (a new entry: only the new one).
  const changes = q.changes?.length ? h('div', { class: 'q-changes' }, ...q.changes.map((c) => h('div', { class: 'q-change', 'data-field': c.field },
    h('span', { class: 'q-change-field' }, t(FIELD_LABELS[AGENT_FIELD_ALIAS[c.field] || c.field] || c.field)),
    h('span', { class: 'q-change-values' },
      c.from === undefined ? null : h('span', { class: 'q-change-old' }, c.from || t('(leer)')),
      c.from === undefined ? null : ' → ',
      h('span', { class: 'q-change-new' }, c.to || t('(leer)')),
      // The host an address really leads to, never cut.
      c.host ? h('span', { class: 'q-change-host' }, t('Ziel: {host}', { host: c.host })) : null)))) : null;
  const target = q.entry ? h('div', { class: 'q-target' },
    h('span', { class: 'q-target-icon' }, icon(q.kind === 'agent-read' || q.kind === 'agent-passkey' ? 'key' : 'edit', 16)),
    h('div', { class: 'q-target-text' }, h('div', { class: 'q-target-entry' }, q.entry),
      // #331: the account that signs in.
      q.username ? h('div', { class: 'q-target-user' }, icon('user', 12), q.username) : null,
      h('div', { class: 'q-target-vault' }, icon('vault', 12), q.vault || '')),
    q.fields?.length ? h('div', { class: 'q-fields' }, ...[...new Set(q.fields.map((f) => AGENT_FIELD_ALIAS[f] || f))].map((f) => h('span', { class: 'q-chip' }, FIELD_LABELS[f] ? t(FIELD_LABELS[f]) : f))) : null,
    changes) : null;
  // A mouse press has to start after the delay too, not only the click that ends it (detail 0: keyboard or script).
  let pressedInTime = false;
  // #439: a passkey use is answered with the app PIN, typed here – the main process checks it, once, for this answer only.
  // #472: Enter in the field confirms when the whole PIN was typed there after the dialog appeared (pinTyping); it does
  // not wait for the button's delay, the typed PIN is the deliberate answer. Pasted, prefilled or too short: nothing.
  const typing = q.pin ? pinTyping() : null;
  const reqKey = `q:${q.id}`;
  const pinMulti = q.pin ? multiHint('q-pin-multi') : null;
  const pinInput = q.pin ? h('input', { type: 'password', class: 'q-pin-input', id: 'q-pin-input', autocomplete: 'off',
    onbeforeinput: () => typing.before(pinInput.value),
    oninput: (e) => typing.input(e, pinInput.value),
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (choice !== null && pinRequests.single(reqKey) && typing.ready(pinInput.value)) submitPin();
    } }) : null;
  const pinError = q.pin ? h('div', { class: 'notice error q-pin-error', role: 'alert', hidden: true }) : null;
  let submitting = false;
  // #537 stage 4: the field takes the master password or the PIN; Windows Hello has its own button (helloAllow), the main
  // process asks Hello for this one use.
  const submitPin = async (viaHello = false) => {
    if (!viaHello && !pinInput.value) { pinInput.focus(); return; }
    if (submitting) return;
    submitting = true;
    try {
      await call('answerQuestion', q.id, choice, viaHello ? { hello: true } : pinInput.value);
    } catch (err) {
      if (viaHello) revealPin(); // Hello cancelled, failed or not there: now the field, and "Erneut mit Windows Hello"
      showPinProblem(pinError, err.message);
      pinInput.value = '';
      typing.reset();
      pinInput.focus();
      startDelay();
      return;
    } finally {
      submitting = false;
    }
    answered = true;
    openQuestions.delete(q.id);
    close();
  };
  // #537 risk 3: with Hello on, the field for the master password or the PIN waits until Hello did not go through.
  // Never automatic for a held question or one sent again after the window's lock (Konrad M1: #507/#417 must hold).
  const mayAuto = !!st.unlock?.hello && !window.kvSmokeNoAutoHello && !q.held && !q.resent;
  const pinBox = q.pin ? h('div', { class: 'q-pin-box', hidden: mayAuto }) : null;
  pinBox?.append(...[helloOr(), h('label', { for: 'q-pin-input' }, proofPrompt(q)), pinInput, pinMulti].filter(Boolean));
  const revealPin = (again = true) => {
    if (!pinBox) return;
    pinBox.hidden = false;
    allow.hidden = false; // Lena 1: "allow" only with the field
    if (helloAllow && again) helloAllow.lastChild.textContent = t(HELLO_AGAIN);
  };
  const allow = h('button', { type: 'button', class: 'btn primary', onpointerdown: () => { pressedInTime = delayPassed; }, onclick: async (e) => {
    if (q.held) return; // #507: allowed only after the window's PIN (the main process refuses it too)
    if (!delayPassed || choice === null || (e.detail > 0 && !pressedInTime)) return;
    if (pinInput) {
      await submitPin();
      return;
    }
    answer(choice);
    close();
  } }, q.allow || t('Erlauben'));
  // The same rules as "allow": after the delay, a click begun in time, an option chosen, never on a held request.
  helloAllow = q.pin && st.unlock?.hello ? h('button', { type: 'button', class: 'btn primary block q-hello-allow', onpointerdown: () => { pressedInTime = delayPassed; }, onclick: async (e) => {
    if (q.held) return;
    if (!delayPassed || choice === null || (e.detail > 0 && !pressedInTime)) return;
    await submitPin(true);
  } }, icon('shield', 14), h('span', {}, t(HELLO_ALLOW))) : null;
  if (helloAllow) allow.classList.remove('primary'); // Hello is the recommended way, the field the alternative
  if (pinBox?.hidden) allow.hidden = true; // Lena 1: while Hello runs it would do nothing
  const body = h('div', { class: `question ${q.kind}` },
    h('div', { class: 'q-hero' },
      h('span', { class: 'q-badge' }, icon(icons[q.kind] || 'shield', 26)),
      h('div', { class: 'q-hero-text' },
        h('div', { class: 'q-eyebrow' }, q.kind === 'confirm-each' ? t('Immer bestätigen') : q.kind === 'held' ? t('Anfrage der Browser-Erweiterung') : t('Anfrage eines KI-Agenten')),
        h('div', { class: 'q-title' }, q.title))),
    q.lead ? h('p', { class: 'q-lead' }, q.lead) : null,
    target,
    entriesList(q.entries),
    filterBar,
    options.length ? h('div', { class: `q-options${filterBar ? ' q-options-scroll' : ''}`, role: 'radiogroup' }, ...options, noHits) : null,
    q.pin ? h('div', { class: 'field q-pin' }, helloAllow, pinBox, pinError) : null,
    q.note ? h('p', { class: 'q-note' }, icon('shield', 13), q.note) : null,
    h('div', { class: 'q-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => { answer(q.cancel); close(); } }, t('Ablehnen')),
      allow));
  const { dialog, close: closeModal } = modal('', body, []);
  dialog.classList.add('question-modal');
  // The dialog's "close" event does not reach a dialog that modal() removes right after closing it: the cleanup runs on
  // every way out (an answer here, the main process's questionClose, Esc/×) – else this request stayed "open" for the
  // others (pinRequests.single: Enter after typing #472, the automatic Windows Hello of #537).
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    answer(q.cancel);
    clearTimeout(delayTimer);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('focus', startDelay);
    window.removeEventListener('blur', startDelay);
    waitingQuestions.delete(startDelay);
    pinRequests.remove(reqKey);
    for (const restart of waitingQuestions) restart();
  };
  dialog.addEventListener('close', cleanup);
  close = () => { cleanup(); closeModal(); };
  openQuestions.set(q.id, () => { answered = true; close(); });
  pinRequests.add(reqKey, typing, (single) => { if (pinMulti) pinMulti.hidden = single; });
  waitingQuestions.add(startDelay);
  startDelay();
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('focus', startDelay);
  window.addEventListener('blur', startDelay);
  // #368: the focus is on no button, so Enter and space do nothing. With a search the cursor starts there.
  body.tabIndex = -1;
  if (pinInput && !pinBox.hidden && !filterBar?.querySelector('.q-search')) focusField(pinInput);
  else (filterBar?.querySelector('.q-search') || body).focus();
  // #537 risk 3 (Lucas: "überall automatisch"): this dialog shows who wants what – Hello starts by itself, once, when
  // an account is chosen; never for a held request (#507), never again after a cancel (then the field and the button).
  if (helloAllow && mayAuto) {
    // Konrad M1: only the one open request, its dialog on top, at most one automatic start within the gap.
    const auto = autoHelloOnce(() => dialog.open && !q.held && !answered && pinRequests.single(reqKey) && onTop(dialog) && Date.now() - lastQuestionAuto >= questionAutoGap(),
      { skipped: () => revealPin(false) });
    tryAutoHello = () => { if (choice !== null && !q.held) auto(() => { lastQuestionAuto = Date.now(); submitPin(true); }); };
    tryAutoHello();
  }
}

/** Success moment after a passkey request from Windows: centred badge animation, gone after about a second. */
export function flashPasskey(text) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = h('div', { class: 'passkey-flash' }, passkeySuccess(text));
  document.body.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 320);
  }, reduced ? 500 : 1300);
}

function windowsDialog(r) {
  const decide = async (decision) => {
    windowsDialogs.delete(r.id);
    await call('windowsDecision', r.id, decision);
    if (!decision.cancel) flashPasskey(r.kind === 'create' ? t('Passkey gespeichert') : t('Angemeldet'));
    reloadAll().catch(() => {});
  };
  const head = h('div', { class: 'unlock-head' }, icon('key', 28), h('div', {},
    h('h3', {}, r.rpName || r.rpId), h('div', { class: 'muted small' }, t('Anfrage von Windows · {rpId}', { rpId: r.rpId }))));
  const lockedHint = r.lockedContainers?.length
    ? notice(t('Gesperrt: {names} – entsperre den Tresor, wenn der Passkey dort liegt.', { names: r.lockedContainers.join(', ') }), 'info') : null;
  let body;
  let buttons;
  const reqKey = `w:${r.id}`;
  let typing = null;
  let pinMulti = null;
  let onFocus = null; // the window's focus listener of a sign-in dialog: removed when the dialog closes (Konrad, 9f3c6f9)
  let afterShow = null; // #537 risk 3: Windows Hello started by itself once the dialog is on screen
  let close = () => {}; // set when the dialog exists (closes it and cleans up)
  if (r.kind === 'get') {
    // #439: every sign-in is confirmed with the app PIN, typed here (the PIN is checked in the app, for this one use).
    const needPin = !!r.pin?.required;
    const noPin = needPin && !r.pin.pinSet;
    // #472: Enter confirms only a PIN typed in full after the dialog appeared, as in the agent request.
    typing = pinTyping();
    pinMulti = multiHint('win-pin-multi');
    const pinInput = needPin && !noPin ? h('input', { type: 'password', class: 'win-pin-input', autocomplete: 'off',
      onbeforeinput: () => typing.before(pinInput.value),
      oninput: (e) => typing.input(e, pinInput.value),
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (r.candidates.length === 1 && pinRequests.single(reqKey) && typing.ready(pinInput.value)) choose(r.candidates[0]);
      } }) : null;
    const pinError = h('div', { class: 'notice error win-pin-error', role: 'alert', hidden: true });
    // Konrad (review of stage 4): Windows Hello from this dialog only by a real click after the delay of #368, counted
    // from the dialog's appearance and from every return of the focus – never a click that was already on its way.
    let shownAt = Date.now();
    onFocus = () => { shownAt = Date.now(); };
    window.addEventListener('focus', onFocus);
    const hello = !!st.unlock?.hello && !!pinInput;
    // #537 risk 3 (Lucas: "überall automatisch"): with Hello on, the field waits until Hello did not go through; one passkey
    // asks Hello by itself once, several after the choice (a click on the passkey). auto: the one start by the dialog.
    let fieldShown = !hello || !!window.kvSmokeNoAutoHello;
    const choose = async (c, e, helloButton = false, auto = false) => {
      const viaHello = hello && (helloButton || !fieldShown);
      if (viaHello && !auto && (!e?.isTrusted || Date.now() - shownAt < CONFIRM_DELAY_MS)) return;
      if (pinInput && !viaHello && !pinInput.value) { pinInput.focus(); return; } // the master password or the PIN first
      try {
        // #537 stage 4: an empty field with Windows Hello on – the main process asks Hello for this one sign-in.
        await call('windowsDecision', r.id, { containerId: c.containerId, itemId: c.itemId, credentialId: c.credentialId, ...(pinInput ? { pin: viaHello ? { hello: true } : pinInput.value } : {}) });
      } catch (e) {
        // Wrong PIN, blocked, Hello cancelled: the request stays open, the dialog stays – now with the field.
        if (viaHello) showField();
        showPinProblem(pinError, e.message);
        if (pinInput) { pinInput.value = ''; typing.reset(); pinInput.focus(); }
        return;
      }
      windowsDialogs.delete(r.id);
      close();
      flashPasskey(t('Angemeldet'));
      reloadAll().catch(() => {});
    };
    const retryButtons = [];
    const helloLabel = h('span', {}, t(HELLO_ALLOW));
    const helloOne = hello && r.candidates.length === 1 ? h('button', { type: 'button', class: 'btn primary block win-hello-allow', onclick: (e) => choose(r.candidates[0], e, true) }, icon('shield', 14), helloLabel) : null;
    const pinFieldBox = pinInput ? h('div', { class: 'win-pin-box', hidden: !fieldShown }, hello ? helloOr() : null, field(passkeyPinPrompt(), pinInput), pinMulti) : null;
    const showField = (again = true) => {
      fieldShown = true;
      if (pinFieldBox) pinFieldBox.hidden = false;
      if (again) helloLabel.textContent = t(HELLO_AGAIN);
      for (const b of retryButtons) b.hidden = false;
    };
    body = h('div', {}, head, lockedHint,
      noPin ? [notice(t('Für Passkeys braucht Keevault eine App-PIN. Lege sie jetzt fest – dann kannst du dich anmelden.'), 'warn'),
        h('p', {}, h('button', { type: 'button', class: 'btn primary', onclick: () => pinDialog({ passkeys: true, onSaved: () => { windowsDialogs.delete(r.id); close(); checkWindowsRequests(); } }) }, icon('key', 14), t('PIN festlegen')))] : null,
      r.candidates.length
        ? [h('p', {}, t('Mit welchem Passkey möchtest du dich anmelden?')),
          // #537 live test / risk 3: Windows Hello as its own button for the one passkey (started by itself), with several
          // the click on a passkey asks Hello; after a cancel the field, and "Windows Hello" beside each passkey.
          hello && r.candidates.length === 1 ? helloOne : null,
          pinFieldBox, pinError,
          ...r.candidates.map((c) => {
            const pick = h('button', { type: 'button', class: 'choice', disabled: noPin, onclick: (e) => choose(c, e) },
              icon('user'), h('span', {}, c.userName || t('(ohne Benutzername)')), h('span', { class: 'muted small' }, `${c.title} · ${c.container}`));
            if (!(hello && r.candidates.length > 1)) return pick;
            const again = h('button', { type: 'button', class: 'btn small win-hello-choice', hidden: true, title: t(HELLO_AGAIN), 'aria-label': `${t(HELLO_AGAIN)}: ${c.userName || c.title}`, onclick: (e) => choose(c, e, true) }, icon('shield', 14), t('Windows Hello'));
            retryButtons.push(again);
            return h('div', { class: 'choice-row' }, pick, again);
          })]
        : h('p', {}, t('Im Tresor ist kein passender Passkey gespeichert.')));
    buttons = [{ label: t('Abbrechen'), onClick: () => decide({ cancel: true }) }];
    if (hello && r.candidates.length === 1 && !fieldShown) {
      afterShow = (dialog) => autoHelloOnce(() => dialog.open && pinRequests.single(reqKey) && onTop(dialog), { skipped: () => showField(false) })(() => choose(r.candidates[0], null, true, true));
    }
  } else {
    const container = h('select', {}, ...r.containers.map((c) => h('option', { value: c.id, selected: c.id === st.settings.defaultContainer }, choiceName(st.containers.find((x) => x.id === c.id) || c))));
    const title = h('input', { value: r.rpName || r.rpId });
    const existing = h('select', {}, h('option', { value: '' }, t('Neuer Eintrag')),
      ...r.logins.map((l, i) => h('option', { value: `${l.containerId}|${l.id}`, selected: i === 0 && l.sameUser }, `${l.title}${l.username ? ` – ${l.username}` : ''} (${l.container})`)));
    body = h('div', {}, head, lockedHint,
      h('p', {}, t('Passkey für {user} in Keevault speichern?', { user: r.user?.name || r.user?.displayName || t('dieses Konto') })),
      r.excluded ? notice(t('Für dieses Konto ist bereits ein Passkey im Tresor gespeichert. Die Website lehnt einen zweiten vermutlich ab.'), 'warn') : null,
      r.containers.length ? [
        field(t('Speichern in'), existing),
        field(t('Tresor'), container),
        field(t('Titel'), title),
      ] : notice(t('Kein Tresor mit Schreibrechten verfügbar.')));
    const syncExisting = () => {
      container.disabled = !!existing.value;
      title.disabled = !!existing.value;
    };
    existing.addEventListener('change', syncExisting);
    syncExisting();
    buttons = [
      { label: t('Abbrechen'), onClick: () => decide({ cancel: true }) },
      { label: t('Passkey speichern'), primary: true, onClick: async () => {
        if (!r.containers.length) return false;
        const [cid, itemId] = existing.value ? existing.value.split('|') : [container.value, ''];
        await decide({ containerId: cid, itemId, title: title.value });
        return true;
      } },
    ];
  }
  const { dialog, close: closeModal } = modal(t('Passkey'), body, buttons);
  if (!dialog.querySelector('.win-pin-box[hidden]')) focusField(dialog.querySelector('.win-pin-input'));
  // Closing with Esc or × cancels the request. The cleanup also on the dialog's own close (its "close" event does not
  // reach the removed dialog – see questionDialog).
  pinRequests.add(reqKey, typing, (single) => { if (pinMulti) pinMulti.hidden = single; });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    pinRequests.remove(reqKey);
    if (onFocus) window.removeEventListener('focus', onFocus);
    if (windowsDialogs.has(r.id)) decide({ cancel: true }).catch(() => {});
  };
  dialog.addEventListener('close', cleanup);
  close = () => { cleanup(); closeModal(); };
  afterShow?.(dialog);
  return close;
}
