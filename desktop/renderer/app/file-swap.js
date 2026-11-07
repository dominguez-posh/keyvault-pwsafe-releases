// Another vault in a known file (#404): before and now side by side – creator and safety code – and taken only after
// the person compared both with the creator outside the app. Someone with write access to the share could otherwise
// put a vault of their own under the team vault's name, and new team entries would land with them.

import { h, icon, toast, modal } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { ui } from './state.js';
import { notice } from './helpers.js';
import { reloadAll } from './shell.js';

const row = (label, before, now) => h('tr', {}, h('th', {}, label), h('td', {}, before || t('unbekannt')), h('td', { class: before && before !== now ? 'changed' : '' }, now || '–'));

export function fileSwapDialog(c) {
  const s = c.swap;
  const check = h('input', { type: 'checkbox', id: 'swap-compared' });
  modal(t('Anderer Tresor in der Datei'), h('div', { class: 'file-swap' },
    notice(t('In der Datei liegt ein anderer Tresor als beim letzten Öffnen. Gleiche Erstellerin und Sicherheitscode mit der Erstellerin außerhalb der App ab (Telefon oder persönlich) – nicht über eine Nachricht aus derselben Quelle. Stimmt etwas nicht, nimm ihn nicht an und sag deiner IT Bescheid.'), 'warn'),
    h('table', { class: 'swap-table' },
      h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, t('Bisher')), h('th', {}, t('Jetzt in der Datei')))),
      h('tbody', {},
        row(t('Name'), s.before.name, s.now.name),
        row(t('Erstellerin'), s.before.creator, s.now.creator || t('keine (Masterpasswort)')),
        row(t('Sicherheitscode'), s.before.code, s.now.code))),
    h('label', { class: 'check' }, check, t('Ich habe Erstellerin und Sicherheitscode mit der Erstellerin abgeglichen'))), [
    { label: t('Nicht annehmen') },
    { label: t('Annehmen'), danger: true, onClick: async () => {
      if (!check.checked) {
        toast(t('Bitte erst mit der Erstellerin abgleichen und bestätigen'), 'error');
        return false;
      }
      ui.containerId = await call('acceptFileSwap', { path: s.path, id: s.now.id });
      toast(t('Tresor angenommen'));
      await reloadAll();
    } },
  ]);
}

/**
 * #446: a known file refused for a changed or missing grant. Repaired from the state known here; until then it must not
 * be opened elsewhere – a device without that state would count the change.
 */
export function fileRepair(c) {
  if (!c?.repairable) return null;
  const btn = h('button', { class: 'btn', id: 'file-repair-btn', onclick: async () => {
    btn.disabled = true;
    try {
      ui.containerId = await call('repairFile', c.id);
      toast(t('Datei aus dem bekannten Stand repariert'));
      await reloadAll();
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
    }
  } }, icon('shield', 14), t('Aus bekanntem Stand reparieren'));
  return h('div', { id: 'file-repair' },
    notice(t('Öffne die Datei bis zur Reparatur nicht an anderer Stelle (anderes Gerät, neu hinzugefügt): Dort fehlt der hier bekannte Stand, und die Änderung würde gelten. Hast du die Datei nicht selbst geändert, sag deiner IT Bescheid.'), 'warn'),
    btn);
}
