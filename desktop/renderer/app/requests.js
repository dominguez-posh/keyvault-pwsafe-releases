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
export function questionDialog(q) {
  let answered = false;
  const answer = (value) => {
    if (answered) return;
    answered = true;
    openQuestions.delete(q.id);
    call('answerQuestion', q.id, value).catch(() => {});
  };
  const icons = { 'agent-connect': 'link', 'agent-read': 'key', 'agent-write': 'edit' };
  let choice = q.choices?.[0]?.value || 'allow';
  const options = (q.choices || []).map((c, i) => {
    const input = h('input', { type: 'radio', name: `q${q.id}`, value: c.value, checked: i === 0, onchange: () => { choice = c.value; } });
    const label = h('label', { class: 'q-option' }, input,
      h('span', { class: 'q-option-text' }, h('span', { class: 'q-option-label' }, c.label), c.hint ? h('span', { class: 'q-option-hint' }, c.hint) : null));
    label.kvChoice = { ...c, input };
    return label;
  });
  // #339: search (title, user name, vault) and vault filter for the account choice – only with more than one account.
  // A hidden choice is never sent: the first visible one is selected, none visible disables "Allow".
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
      let firstVisible = null;
      for (const o of options) {
        const c = o.kvChoice;
        o.hidden = !(words.every((w) => c.search.includes(w)) && (!vault || c.vault === vault));
        if (!o.hidden && !firstVisible) firstVisible = o;
      }
      const current = options.find((o) => o.kvChoice.value === choice);
      if ((!current || current.hidden) && firstVisible) {
        firstVisible.kvChoice.input.checked = true;
        choice = firstVisible.kvChoice.value;
      }
      noHits.hidden = !!firstVisible;
      allow.disabled = !firstVisible;
    };
    search.addEventListener('input', applyFilter);
    vaultSelect?.addEventListener('change', applyFilter);
    // Enter in the search takes the selected (first visible) account.
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !allow.disabled) { e.preventDefault(); allow.click(); } });
    filterBar = h('div', { class: 'q-filter' }, h('span', { class: 'q-search-wrap' }, icon('search', 14), search), vaultSelect);
  }
  const target = q.entry ? h('div', { class: 'q-target' },
    h('span', { class: 'q-target-icon' }, icon(q.kind === 'agent-read' || q.kind === 'agent-passkey' ? 'key' : 'edit', 16)),
    h('div', { class: 'q-target-text' }, h('div', { class: 'q-target-entry' }, q.entry),
      // #331: the account that signs in.
      q.username ? h('div', { class: 'q-target-user' }, icon('user', 12), q.username) : null,
      h('div', { class: 'q-target-vault' }, icon('vault', 12), q.vault || '')),
    q.fields?.length ? h('div', { class: 'q-fields' }, ...[...new Set(q.fields.map((f) => AGENT_FIELD_ALIAS[f] || f))].map((f) => h('span', { class: 'q-chip' }, FIELD_LABELS[f] ? t(FIELD_LABELS[f]) : f))) : null) : null;
  const allow = h('button', { type: 'button', class: 'btn primary', onclick: () => { answer(choice); close(); } }, q.allow || t('Erlauben'));
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
  dialog.addEventListener('close', () => answer(q.cancel));
  openQuestions.set(q.id, () => { answered = true; close(); });
  // With a search the cursor starts there (type, Enter); otherwise on the main button.
  (filterBar?.querySelector('.q-search') || allow).focus();
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
