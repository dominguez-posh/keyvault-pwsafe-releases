// Requests that come to the window by themselves: passkey requests from Windows and questions of AI agents.

import { h, icon, toast, modal, passkeySuccess } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { st } from './state.js';
import { field, notice } from './helpers.js';
import { FIELD_LABELS } from './file-vaults.js';
import { reloadAll } from './shell.js';

const windowsDialogs = new Map(); // request id → close()

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

/**
 * Question from the main process (AI agent wants to connect, read a password or change an entry): a dialog in the
 * app's style – agent badge, request, answers as buttons (the recommended one highlighted). Escape or × = cancel.
 */
export const openQuestions = new Map(); // id → close without answer
// MCP argument names that differ from the item fields (FIELD_LABELS below).
const AGENT_FIELD_ALIAS = { url: 'urls', generatePassword: 'password' };
// #368: "Allow" only works this long after the question appeared and after the last key press, so that someone who was
// typing for another program and keeps typing cannot answer it, not even with Tab and Enter.
const CONFIRM_DELAY_MS = 1200;
// Questions still open: closing one starts the delay of those below it again, they come up under the mouse pointer.
const waitingQuestions = new Set();
export function questionDialog(q) {
  let answered = false;
  const answer = (value) => {
    if (answered) return;
    answered = true;
    openQuestions.delete(q.id);
    call('answerQuestion', q.id, value).catch(() => {});
  };
  const icons = { 'agent-connect': 'link', 'agent-read': 'key', 'agent-write': 'edit' };
  // #368: the account choice starts without a selection, the user picks the account that is handed to the tool.
  let choice = q.filter ? null : q.choices?.[0]?.value || 'allow';
  let delayPassed = false;
  let delayTimer = null;
  // During the delay the button only looks disabled: a really disabled button would lose the keyboard focus and get no
  // more key presses. Disabled for real only without a choice, where it can't have the focus.
  const updateAllow = () => {
    allow.disabled = choice === null;
    allow.setAttribute('aria-disabled', String(!delayPassed));
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
    const confirming = (e.target === allow && (e.key === 'Enter' || e.key === ' '))
      || (q.filter && e.key === 'Enter' && e.target.matches?.('.q-option input:checked'));
    if (!delayPassed || !confirming) startDelay();
  };
  const options = (q.choices || []).map((c, i) => {
    const input = h('input', { type: 'radio', name: `q${q.id}`, value: c.value, checked: !q.filter && i === 0,
      onchange: () => { choice = c.value; updateAllow(); },
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
  const allow = h('button', { type: 'button', class: 'btn primary', onclick: () => {
    if (!delayPassed || choice === null) return;
    answer(choice);
    close();
  } }, q.allow || t('Erlauben'));
  const body = h('div', { class: `question ${q.kind}` },
    h('div', { class: 'q-hero' },
      h('span', { class: 'q-badge' }, icon(icons[q.kind] || 'shield', 26)),
      h('div', { class: 'q-hero-text' },
        h('div', { class: 'q-eyebrow' }, t('Anfrage eines KI-Agenten')),
        h('div', { class: 'q-title' }, q.title))),
    q.lead ? h('p', { class: 'q-lead' }, q.lead) : null,
    target,
    filterBar,
    options.length ? h('div', { class: `q-options${filterBar ? ' q-options-scroll' : ''}`, role: 'radiogroup' }, ...options, noHits) : null,
    q.note ? h('p', { class: 'q-note' }, icon('shield', 13), q.note) : null,
    h('div', { class: 'q-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => { answer(q.cancel); close(); } }, t('Ablehnen')),
      allow));
  const { dialog, close } = modal('', body, []);
  dialog.classList.add('question-modal');
  dialog.addEventListener('close', () => {
    answer(q.cancel);
    clearTimeout(delayTimer);
    document.removeEventListener('keydown', onKey, true);
    waitingQuestions.delete(startDelay);
    for (const restart of waitingQuestions) restart();
  });
  openQuestions.set(q.id, () => { answered = true; close(); });
  waitingQuestions.add(startDelay);
  startDelay();
  document.addEventListener('keydown', onKey, true);
  // #368: the focus is on no button, so Enter and space do nothing. With a search the cursor starts there.
  body.tabIndex = -1;
  (filterBar?.querySelector('.q-search') || body).focus();
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
  if (r.kind === 'get') {
    body = h('div', {}, head, lockedHint,
      r.candidates.length
        ? [h('p', {}, t('Mit welchem Passkey möchtest du dich anmelden?')), ...r.candidates.map((c) => h('button', { type: 'button', class: 'choice', onclick: () => {
          close();
          decide({ containerId: c.containerId, itemId: c.itemId, credentialId: c.credentialId }).catch((e) => toast(e.message, 'error'));
        } }, icon('user'), h('span', {}, c.userName || t('(ohne Benutzername)')), h('span', { class: 'muted small' }, `${c.title} · ${c.container}`)))]
        : h('p', {}, t('Im Tresor ist kein passender Passkey gespeichert.')));
    buttons = [{ label: t('Abbrechen'), onClick: () => decide({ cancel: true }) }];
  } else {
    const container = h('select', {}, ...r.containers.map((c) => h('option', { value: c.id, selected: c.id === st.settings.defaultContainer }, c.name)));
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
  const { dialog, close } = modal(t('Passkey'), body, buttons);
  // Closing with Esc or × cancels the request.
  dialog.addEventListener('close', () => {
    if (windowsDialogs.has(r.id)) decide({ cancel: true }).catch(() => {});
  });
  return close;
}
