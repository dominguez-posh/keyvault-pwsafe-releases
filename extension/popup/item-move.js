// Popup (#464): linked assets, moving an entry with its assets and moving a passkey – the same dialogs as in the app,
// through the app's bridge commands (rights, keys and the all-or-nothing move stay in the app). The popup shows these
// only when the app reports the capability (state.canAssets / canMove / canMovePasskey).

import { h, icon, setChildren, toast, modal, avatar } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { call } from '../lib/api.js';

const ROLES = { user: 'verwendet diesen Eintrag', linked: 'wird nur von diesen Einträgen verwendet' };
const USES = { rdp: 'RDP-Konto', teamviewer: 'TeamViewer-Passwort', bastionLogin: 'Microsoft-Anmeldung (Bastion)', bastionVm: 'Konto auf dem Server (Bastion)', login: 'Verknüpfter Login' };
const notice = (text, kind = 'error') => h('div', { class: `notice ${kind}` }, text);

const planRow = (entry, sub) => h('div', { class: 'move-plan-row', dataset: { id: entry.id } }, avatar(entry.title),
  h('span', { class: 'link-pick-main' }, h('span', { class: 'link-pick-text' }, entry.title), h('span', { class: 'link-pick-sub' }, sub)));

/** The assets and linked logins that use this login, each opened with a click (ctx.open(summary)). */
export async function linkedAssetsDialog(item, ctx) {
  const list = h('div', { class: 'link-pick-list linked-assets-list' }, h('span', { class: 'spinner' }));
  const { close } = modal(t('Verknüpfte Assets von „{title}“', { title: item.title }), list, [{ label: t('Schließen') }]);
  let entries;
  try {
    entries = await call('linkedEntries', { containerId: item.containerId, id: item.id });
  } catch (e) {
    setChildren(list, notice(e.message));
    return;
  }
  setChildren(list, entries.length ? entries.map((e) => h('button', { type: 'button', class: 'link-pick-row', dataset: { key: e.key }, onclick: () => {
    close();
    ctx.open({ containerId: e.containerId, id: e.id });
  } }, avatar(e.title),
  h('span', { class: 'link-pick-main' }, h('span', { class: 'link-pick-text' }, e.title), h('span', { class: 'link-pick-sub' }, e.uses.map((u) => t(USES[u])).join(' · ')))))
    : [h('p', { class: 'muted' }, t('Kein Asset und kein Login verwendet diesen Eintrag.'))]);
}

/** Move dialog: target vault, what moves along (the plan is calculated in the app), then all together or only the entry. */
export function moveDialog(item, ctx) {
  const targets = ctx.writableContainers().filter((c) => c.id !== item.containerId);
  if (!targets.length) {
    toast(t('Kein anderer Tresor mit Schreibrechten'), 'error');
    return;
  }
  const target = h('select', { name: 'target' }, ...targets.map((c) => h('option', { value: c.id }, c.name)));
  const node = h('div', { class: 'move-plan' });
  const check = h('input', { type: 'checkbox', name: 'moveAssets', checked: true });
  let plan = null;
  let seq = 0;
  const extras = () => (plan?.members || []).filter((m) => m.role !== 'selected');
  const show = () => {
    if (!plan) return setChildren(node, h('span', { class: 'spinner' }));
    const parts = [];
    if (plan.refused) parts.push(notice(plan.refused));
    if (!plan.refused && extras().length) {
      parts.push(h('label', { class: 'inline' }, check, t('Verknüpfte Assets mitverschieben ({n})', { n: extras().length })));
      parts.push(h('div', { class: 'move-plan-list' }, ...extras().map((m) => planRow(m, t(ROLES[m.role])))));
      if (plan.dropped.length) {
        parts.push(notice(t('Diese Verknüpfungen werden aus dem verschobenen Eintrag entfernt, weil das Ziel im Quelltresor bleibt oder in einem dritten Tresor liegt (Verknüpfungen gelten nur innerhalb eines Tresors). Im Zieltresor neu wählen: {list}', {
          list: plan.dropped.map((d) => `${d.title} (${d.uses.map((u) => t(USES[u])).join(', ')})`).join('; '),
        }), 'warn'));
      }
      parts.push(h('p', { class: 'muted small' }, t('Alles oder nichts: Schlägt ein Eintrag fehl, bleibt im Quelltresor alles unverändert.')));
    }
    if (plan.blocked.length) {
      parts.push(h('p', { class: 'muted small' }, plan.refused ? t('Betroffene Einträge, die nicht verschoben werden:') : t('Diese verknüpften Einträge werden nicht verschoben:')));
      parts.push(h('div', { class: 'move-plan-list' }, ...plan.blocked.map((b) => planRow(b, b.reason))));
    }
    setChildren(node, parts);
  };
  const load = async () => {
    const n = ++seq;
    plan = null;
    show();
    let next;
    try {
      next = await call('planMove', { fromId: item.containerId, toId: target.value, id: item.id });
    } catch (e) {
      next = { refused: e.message, members: [], blocked: [], dropped: [] };
    }
    if (n !== seq) return;
    plan = next;
    show();
  };
  target.addEventListener('change', load);
  load();

  modal(t('Eintrag verschieben'), h('div', {},
    h('label', { class: 'field' }, h('span', {}, t('„{title}“ verschieben nach', { title: item.title })), target),
    h('p', { class: 'muted small' }, t('Der Eintrag wird im Ziel neu angelegt und in der Quelle gelöscht. Der bisherige Verlauf bleibt bis zum Ende der Aufbewahrungsfrist in der Quelle.')),
    node), [
    { label: t('Abbrechen') },
    { label: t('Verschieben'), primary: true, onClick: async () => {
      if (!plan) throw new Error(t('Die Verknüpfungen werden noch geprüft'));
      if (plan.refused) throw new Error(plan.refused);
      const base = { fromId: item.containerId, toId: target.value, id: item.id };
      let res;
      try {
        if (extras().length && check.checked) res = await call('moveWithAssets', { ...base, expected: plan.members.map((m) => m.id) });
        else {
          const saved = await call('move', { ...base, expectedVersion: item.version });
          res = { saved, dropped: saved.droppedLinks?.length ? [{ title: saved.title, uses: saved.droppedLinks }] : [] };
        }
      } catch (e) {
        // Partly done is possible: the message says what lies where; the list shows the real state.
        toast(e.message, 'error');
        await ctx.reload();
        return undefined;
      }
      toast(res.dropped?.length ? t('Verschoben. Verknüpfungen neu wählen: {list}', { list: res.dropped.flatMap((d) => d.uses.map((u) => t(USES[u]) || u)).join(', ') })
        : res.moved?.length > 1 ? t('{n} Einträge verschoben', { n: res.moved.length }) : t('Verschoben'));
      await ctx.reload();
      return undefined;
    } },
  ]);
}

/** Passkey saved in the wrong entry: pick another login (writable vault); entries of the same site and user come first. */
export function movePasskeyDialog(item, passkey, ctx) {
  const user = String(passkey.userName || '').trim().toLowerCase();
  const hostOf = (rpId) => (x) => x === rpId || x.endsWith(`.${rpId}`) || rpId.endsWith(`.${x}`);
  const score = (s) => (s.hosts.some(hostOf(passkey.rpId)) ? 2 : 0) + (user && String(s.username || '').trim().toLowerCase() === user ? 1 : 0);
  const writable = new Set(ctx.writableContainers().map((c) => c.id));
  const targets = ctx.items()
    .filter((s) => s.type === 'login' && !(s.containerId === item.containerId && s.id === item.id) && writable.has(s.containerId))
    .sort((a, b) => score(b) - score(a) || a.title.localeCompare(b.title));
  if (!targets.length) {
    toast(t('Kein anderer Login-Eintrag mit Schreibrechten vorhanden'), 'error');
    return;
  }
  let chosen = `${targets[0].containerId}/${targets[0].id}`;
  const search = h('input', { type: 'search', class: 'link-pick-search', placeholder: t('Eintrag suchen (Titel, Benutzer, Tresor) …'), 'aria-label': t('Eintrag suchen') });
  const list = h('div', { class: 'link-pick-list', role: 'listbox' });
  const LIMIT = 100;
  const draw = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = targets.filter((s) => words.every((w) => [s.title, s.username, ctx.containerName(s.containerId)].join(' ').toLowerCase().includes(w)));
    if (!hits.some((s) => `${s.containerId}/${s.id}` === chosen)) chosen = hits[0] ? `${hits[0].containerId}/${hits[0].id}` : '';
    setChildren(list, [
      ...hits.slice(0, LIMIT).map((s) => {
        const key = `${s.containerId}/${s.id}`;
        return h('button', { type: 'button', role: 'option', class: `link-pick-row ${key === chosen ? 'on' : ''}`, 'aria-selected': String(key === chosen), dataset: { key },
          onclick: () => { chosen = key; draw(); } },
        avatar(s.title), h('span', { class: 'link-pick-main' }, h('span', { class: 'link-pick-text' }, s.title),
          h('span', { class: 'link-pick-sub' }, [s.username, ctx.containerName(s.containerId)].filter(Boolean).join(' · '))),
        key === chosen ? icon('check', 14) : null);
      }),
      hits.length ? null : h('p', { class: 'muted small link-pick-empty' }, t('Kein Eintrag gefunden.')),
      hits.length > LIMIT ? h('p', { class: 'muted small link-pick-empty' }, t('{count} weitere – Suche verfeinern', { count: hits.length - LIMIT })) : null,
    ].filter(Boolean));
  };
  search.addEventListener('input', draw);
  draw();
  modal(t('Passkey verschieben'), h('div', { class: 'link-pick-dialog' },
    h('p', {}, t('Passkey für {user} ({rpId}) in einen anderen Eintrag verschieben.', { user: passkey.userName || passkey.userDisplayName || t('(ohne Benutzername)'), rpId: passkey.rpId })),
    search, list), [
    { label: t('Abbrechen') },
    { label: t('Verschieben'), primary: true, onClick: async () => {
      if (!chosen) return false;
      const [containerId, ...rest] = chosen.split('/');
      await call('movePasskey', { from: { containerId: item.containerId, id: item.id }, to: { containerId, id: rest.join('/') }, credentialId: passkey.credentialId });
      toast(t('Passkey verschoben'));
      await ctx.reload();
      return undefined;
    } },
  ]);
}
