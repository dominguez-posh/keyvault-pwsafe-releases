// Move dialog part for linked assets (#452): shows which entries move along, which cannot and which links get lost,
// and runs the move (all together or, when unticked, only the entry itself).

import { h, setChildren } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { notice } from './helpers.js';
import { itemAvatar } from './icons.js';

const ROLES = { user: 'verwendet diesen Eintrag', linked: 'wird nur von diesen Einträgen verwendet' };
const USES = { rdp: 'RDP-Konto', teamviewer: 'TeamViewer-Passwort', bastionLogin: 'Microsoft-Anmeldung (Bastion)', bastionVm: 'Konto auf dem Server (Bastion)', login: 'Verknüpfter Login' };

const row = (item, sub) => h('div', { class: 'move-plan-row', dataset: { id: item.id } }, itemAvatar({ key: item.id, title: item.title, type: item.type }),
  h('span', { class: 'link-pick-main' }, h('span', { class: 'link-pick-text' }, item.title), h('span', { class: 'link-pick-sub' }, sub)));

/**
 * The panel for moving `item` into the vault chosen in the `target` select: reloads when the target changes.
 * → { node, run() } – run() moves and returns { saved, dropped } (throws with the message of the failure).
 */
export function movePlanPanel(item, target) {
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
      parts.push(h('div', { class: 'move-plan-list' }, ...extras().map((m) => row(m, t(ROLES[m.role])))));
      if (plan.dropped.length) {
        parts.push(notice(t('Diese Verknüpfungen werden aus dem verschobenen Eintrag entfernt, weil das Ziel im Quelltresor bleibt oder in einem dritten Tresor liegt (Verknüpfungen gelten nur innerhalb eines Tresors). Im Zieltresor neu wählen: {list}', {
          list: plan.dropped.map((d) => `${d.title} (${d.uses.map((u) => t(USES[u])).join(', ')})`).join('; '),
        }), 'warn'));
      }
      parts.push(h('p', { class: 'muted small' }, t('Alles oder nichts: Schlägt ein Eintrag fehl, bleibt im Quelltresor alles unverändert.')));
      parts.push(h('p', { class: 'muted small' }, t('Passkeys wandern mit, der Verlauf (alte Versionen) bleibt im Quelltresor.')));
    }
    if (plan.blocked.length) {
      parts.push(h('p', { class: 'muted small' }, plan.refused ? t('Betroffene Einträge, die nicht verschoben werden:') : t('Diese verknüpften Einträge werden nicht verschoben:')));
      parts.push(h('div', { class: 'move-plan-list' }, ...plan.blocked.map((b) => row(b, b.reason))));
    }
    setChildren(node, parts);
  };
  const load = async () => {
    const n = ++seq;
    plan = null;
    show();
    let next;
    try {
      next = await call('planMove', item.containerId, target.value, item.id);
    } catch (e) {
      next = { refused: e.message, members: [], blocked: [], dropped: [] };
    }
    if (n !== seq) return;
    plan = next;
    show();
  };
  target.addEventListener('change', load);
  load();

  return {
    node,
    async run() {
      if (!plan) throw new Error(t('Die Verknüpfungen werden noch geprüft'));
      if (plan.refused) throw new Error(plan.refused);
      if (extras().length && check.checked) return call('moveWithAssets', item.containerId, target.value, item.id, { expected: plan.members.map((m) => m.id) });
      const saved = await call('move', item.containerId, target.value, item.id);
      return { saved, dropped: saved.droppedLinks?.length ? [{ title: saved.title, uses: saved.droppedLinks }] : [] };
    },
  };
}
