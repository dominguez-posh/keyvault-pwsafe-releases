// The trash of a vault and the notice after deleting.

import { h, icon, toast, modal, confirmDialog, formatDateTime } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { st, ui } from './state.js';
import { notice } from './helpers.js';
import { reloadAll } from './shell.js';
import { containerIcon } from './sidebar.js';
import { featureAllowed } from './vault-menu.js';

// Retention per vault (days, from the vault's Azure properties); null when it cannot be read (no ARM access).
const retentionCache = new Map();

/** Trash of a vault: deleted entries until the end of the retention period – restore, or purge if the vault settings allow it. */
/** Main menu → Trash: the vault on screen, otherwise a short choice of the vaults. */
export function openTrash() {
  const shown = ui.containerId && st.containers.find((c) => c.id === ui.containerId);
  if (shown && !shown.error && !shown.locked) return trashDialog(shown);
  const ready = st.containers.filter((c) => !c.error && !c.locked);
  if (ready.length === 1) return trashDialog(ready[0]);
  const { close } = modal(t('Papierkorb'), h('div', {},
    h('p', { class: 'muted' }, t('Von welchem Tresor?')),
    ...ready.map((c) => h('button', { type: 'button', class: 'choice', onclick: () => { close(); trashDialog(c); } }, containerIcon(c), h('span', {}, c.name)))), [{ label: t('Abbrechen') }]);
  return undefined;
}

export function trashDialog(container) {
  const listEl = h('div', {}, h('span', { class: 'spinner' }));
  const load = async () => {
    const entries = await call('trash', container.id);
    listEl.replaceChildren(...(entries.length ? entries.map((e) => h('div', { class: 'member' },
      icon('trash'),
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title' }, e.title),
        h('div', { class: 'row-sub' }, e.scheduledPurgeDate
          ? t('gelöscht {deleted} · endgültig ab {purge}', { deleted: formatDateTime(e.deletedDate), purge: formatDateTime(e.scheduledPurgeDate) })
          : t('gelöscht {deleted}', { deleted: formatDateTime(e.deletedDate) }))),
      h('button', { type: 'button', class: 'btn small', dataset: { restore: e.id }, onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try {
          await call('restore', container.id, e.id);
          toast(t('Wiederhergestellt'));
          await reloadAll();
          await load();
        } catch (err) {
          toast(err.message, 'error');
        }
      } }, t('Wiederherstellen')),
      !featureAllowed(container, 'purge') ? null : h('button', { type: 'button', class: 'btn small danger', onclick: async () => {
        if (!(await confirmDialog(t('Endgültig löschen'), t('„{title}“ endgültig löschen? Das lässt sich nicht rückgängig machen.', { title: e.title }), { confirmLabel: t('Endgültig löschen'), danger: true }))) return;
        try {
          await call('purge', container.id, e.id);
          await load();
        } catch (err) {
          toast(err.message, 'error');
        }
      } }, t('Endgültig löschen')))) : [h('p', { class: 'muted' }, t('Der Papierkorb ist leer.'))]));
  };
  modal(t('Papierkorb – {name}', { name: container.name }), h('div', {},
    container.kind === 'file' ? null : h('p', { class: 'muted small' }, t('Gelöschte Einträge bleiben im Key Vault (Soft Delete) bis zum Ende der Aufbewahrungsfrist und lassen sich bis dahin hier oder im Azure-Portal wiederherstellen. Mit Löschschutz ist endgültiges Löschen erst danach möglich.')),
    listEl), [{ label: t('Schließen') }]);
  load().catch((e) => listEl.replaceChildren(notice(e.message)));
}

/**
 * Text for delete confirmations. Key Vault keeps deleted secrets for its retention period (soft delete, always on):
 * they can be restored from the trash (vault menu) or in the Azure portal. File vaults keep deleted entries in their own trash.
 */
export async function deleteNotice(container) {
  if (!container) return '';
  if (container.kind === 'file') return t('Der Eintrag bleibt im Papierkorb des Datei-Tresors, bis er dort endgültig gelöscht wird.');
  if (!retentionCache.has(container.id)) {
    const days = await Promise.race([
      call('vaultInfo', container.id).then((x) => x?.retentionDays || null, () => null),
      new Promise((r) => { setTimeout(() => r(undefined), 2500); }),
    ]);
    if (days !== undefined) retentionCache.set(container.id, days);
  }
  const days = retentionCache.get(container.id);
  return days
    ? t('{days} Tage lang im Papierkorb wiederherstellbar (Rechtsklick auf den Tresor → Papierkorb, oder im Azure-Portal), danach endgültig gelöscht.', { days })
    : t('Während der Aufbewahrungsfrist des Key Vaults (7–90 Tage) im Papierkorb wiederherstellbar, danach endgültig gelöscht.');
}
