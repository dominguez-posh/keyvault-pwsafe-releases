// Sharing a Key Vault vault: members, access levels, invitations.

import { h, icon, iconButton, toast, modal, confirmDialog } from '../../../extension/core/dom.js';
import { ACCESS_LEVELS } from '../../../extension/core/azure.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { LEVEL_LABEL, copy, notice } from './helpers.js';

export async function shareDialog(container) {
  const listEl = h('div', {}, h('span', { class: 'spinner' }));
  const search = h('input', { placeholder: t('Name, E-Mail oder Sicherheitsgruppe suchen …') });
  const results = h('div', { class: 'search-results' });
  const level = h('select', {}, ...Object.entries(ACCESS_LEVELS).map(([k, v]) => h('option', { value: k, selected: k === 'write' }, t(v.label))));
  const chosenEl = h('div', { class: 'chosen muted' }, t('Niemand ausgewählt'));
  let chosen = null;

  const load = async () => {
    try {
      const members = await call('members', container.id);
      listEl.replaceChildren(...(members.length ? members.map(memberRow) : [h('p', { class: 'muted' }, t('Keine Rollenzuweisungen gefunden.'))]));
    } catch (e) {
      listEl.replaceChildren(notice(e.message));
    }
  };
  const memberRow = (m) => h('div', { class: 'member' },
    icon(m.principalType === 'Group' ? 'users' : 'user'),
    h('div', { class: 'row-text' },
      h('div', { class: 'row-title' }, m.displayName),
      h('div', { class: 'row-sub' }, [m.detail, m.assignments.map((a) => (a.inherited ? t('{role} (geerbt)', { role: a.label }) : a.label)).join(', ')].filter(Boolean).join(' · '))),
    h('span', { class: m.level === 'none' ? 'badge warn' : 'badge accent' }, t(LEVEL_LABEL[m.level])),
    m.removable ? iconButton('trash', t('Zugriff entfernen'), async () => {
      if (!(await confirmDialog(t('Zugriff entfernen'), t('Zugriff von „{who}“ auf „{name}“ entfernen?', { who: m.displayName, name: container.name }), { confirmLabel: t('Entfernen'), danger: true }))) return;
      try {
        await call('removeMember', container.id, m.principalId);
        toast(t('Zugriff entfernt'));
        load();
      } catch (e) {
        toast(e.message, 'error');
      }
    }) : null);

  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const query = search.value.trim();
      const found = await call('searchPrincipals', query, container.id).catch((e) => {
        toast(e.message, 'error');
        return [];
      });
      // Unknown e-mail address: offer to invite the person as guest into the vault's tenant.
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query) ? query.toLowerCase() : null;
      if (email && !found.some((p) => [p.detail, p.mail].some((v) => String(v || '').toLowerCase() === email))) {
        found.push({ invite: true, email, type: 'User', displayName: t('„{email}“ als Gast einladen', { email }), detail: t('Neue Person im Verzeichnis dieses Key Vaults') });
      }
      results.replaceChildren(...found.map((p) => h('button', { type: 'button', class: 'choice', onclick: () => {
        chosen = p;
        chosenEl.textContent = p.invite ? t('{email} (wird als Gast eingeladen)', { email: p.email }) : `${p.displayName} – ${p.type === 'Group' ? t('Gruppe') : p.detail}`;
        chosenEl.classList.remove('muted');
        results.replaceChildren();
      } }, icon(p.invite ? 'plus' : p.type === 'Group' ? 'users' : 'user'), h('span', {}, p.displayName), h('span', { class: 'muted small' }, p.detail))));
    }, 300);
  });

  const add = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    if (!chosen) {
      toast(t('Bitte zuerst eine Person oder Gruppe auswählen'), 'error');
      return;
    }
    add.disabled = true;
    try {
      const r = chosen.invite
        ? await call('inviteGuest', container.id, chosen.email, level.value)
        : await call('addMember', container.id, chosen, level.value);
      toast(chosen.invite
        ? t('{email} als Gast eingeladen und freigegeben – die Person bekommt eine Einladungs-E-Mail', { email: chosen.email })
        : r.discoverable ? t('Freigegeben') : t('Freigegeben – Einladungslink senden, damit der Tresor automatisch erscheint'));
      chosen = null;
      chosenEl.textContent = t('Niemand ausgewählt');
      chosenEl.classList.add('muted');
      search.value = '';
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      add.disabled = false;
    }
  } }, icon('plus'), t('Freigeben'));

  modal(t('„{name}“ freigeben', { name: container.name }), h('div', {},
    h('p', { class: 'muted small' }, t('Freigaben sind Azure-Rollenzuweisungen auf dem Key Vault: Lesen = Key Vault Secrets User, Bearbeiten = Key Vault Secrets Officer, Verwalten = zusätzlich Key Vault Data Access Administrator.')),
    container.protected ? notice(t('Der Tresor ist zusätzlich geschützt: Neue Mitglieder brauchen außerdem eine Einladung (Schutz und Benutzer → Benutzer einladen).'), 'info') : null,
    h('h3', {}, t('Zugriff hinzufügen')),
    search,
    results,
    h('div', { class: 'field-row', style: { marginTop: '8px', gap: '8px' } }, chosenEl, h('div', { style: { width: '150px' } }, level), add),
    h('h3', {}, t('Mitglieder')),
    listEl,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => copy(call('invite', container.id), t('Einladungslink')) }, icon('link'), t('Einladungslink kopieren')))),
  [{ label: t('Schließen') }]);
  load();
}
