// What can be done with one entry: its menu, generator, versions, move, duplicate, favourite, import.

import { h, icon, setChildren, toast, modal, confirmDialog, formatDateTime } from '../../../extension/core/dom.js';
import { itemDetail, generatorPanel } from '../../../extension/core/ui-item.js';
import { DEFAULT_OPTIONS } from '../../../extension/core/generator.js';
import { importDialog } from '../../../extension/core/ui-import.js';
import { t } from '../../../extension/core/i18n.js';
import { resolveLogin } from '../../../extension/core/model.js';
import { buildItemLink } from '../../../extension/core/links.js';
import { call } from './ipc.js';
import { items, progressListeners, st, ui } from './state.js';
import { containerName, copy, field, notice, openUrl, writable, writableContainers } from './helpers.js';
import { agentTrust, loadAgentTrust } from './agents.js';
import { newItem, renderDetail, splitKey } from './detail.js';
import { FIELD_LABELS } from './file-vaults.js';
import { itemAvatar } from './icons.js';
import { copyItemLink } from './item-links.js';
import { renderList } from './list.js';
import { droppedLinksText, multiActions, selectionSize } from './multi.js';
import { reloadAll, render } from './shell.js';
import { deleteNotice } from './trash.js';

/** Stand-alone password generator: copy, type into another window or start a new entry with it. */
export function generatorDialog() {
  let options = { ...DEFAULT_OPTIONS };
  try {
    options = { ...options, ...JSON.parse(localStorage.getItem('generator') || '{}') };
  } catch {
    // Defaults.
  }
  let password = '';
  const panel = generatorPanel(options, (pw) => {
    password = pw;
    try {
      localStorage.setItem('generator', JSON.stringify(options));
    } catch {
      // Not persisted.
    }
  });
  panel.regenerate();
  const { close } = modal(t('Passwort-Generator'), h('div', {},
    panel,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn small', onclick: () => copy(password, t('Passwort')) }, icon('copy', 14), t('Kopieren')),
      h('button', { type: 'button', class: 'btn small', onclick: async () => {
        close();
        try {
          await call('typeGenerated', password);
        } catch (e) {
          toast(e.message, 'error');
        }
      } }, icon('fill', 14), t('Abtippen (ins vorherige Fenster)')),
      st?.opened ? h('button', { type: 'button', class: 'btn small primary', onclick: () => {
        close();
        ui.newPassword = password;
        newItem();
      } }, icon('plus', 14), t('Neuer Eintrag damit')) : null)), [{ label: t('Schließen') }]);
}

export function itemActions(i) {
  if (selectionSize() > 1 && ui.multi.has(i.key)) return multiActions();
  const [containerId, id] = splitKey(i.key);
  const c = st.containers.find((x) => x.id === containerId) || {};
  const canWrite = writable(c);
  const open = async () => call('item', containerId, id);
  // Copying takes the sign-in the entry uses (a linked login: the linked entry's user name and password).
  const usable = async () => resolveLogin(await open(), (c, x) => call('item', c, x));
  const openSite = async () => {
    const u = await usable();
    if (u.linked?.microsoft) return call('openWithMicrosoft', { containerId, id, url: `https://${i.hosts[0]}` }).catch((e) => toast(e.message, 'error'));
    return openUrl(`https://${i.hosts[0]}`);
  };
  return [
    { action: 'favorite', icon: 'star', label: i.favorite ? t('Aus Favoriten entfernen') : t('Zu Favoriten hinzufügen'), disabled: !canWrite, onClick: () => toggleFavorite(i) },
    '-',
    i.username || i.loginLinked ? { action: 'copy-user', icon: 'copy', label: t('Benutzername kopieren'), onClick: async () => copy((await usable()).username, t('Benutzername')) } : null,
    i.type === 'login' || i.type === 'certificate' ? { action: 'copy-password', icon: 'copy', label: t('Passwort kopieren'), onClick: async () => copy((await usable()).password, t('Passwort')) } : null,
    i.type === 'card' ? { action: 'copy-card', icon: 'copy', label: t('Kartennummer kopieren'), onClick: async () => copy((await open()).card.number, t('Kartennummer')) } : null,
    i.hosts?.[0] ? { action: 'open', icon: 'external', label: t('Website öffnen'), onClick: () => (i.loginLinked ? openSite() : openUrl(`https://${i.hosts[0]}`)) } : null,
    '-',
    { action: 'edit', icon: 'edit', label: t('Bearbeiten'), disabled: !canWrite, onClick: async () => {
      ui.selected = i.key;
      ui.editing = 'edit';
      ui.editingItem = await open();
      renderList();
      renderDetail();
    } },
    { action: 'duplicate', icon: 'copy', label: t('Duplizieren'), disabled: !canWrite, onClick: () => duplicateItem(containerId, id) },
    { action: 'history', icon: 'history', label: t('Verlauf'), onClick: async () => historyDialog(await open()) },
    { action: 'copy-link', icon: 'link', label: t('Link kopieren'), disabled: !buildItemLink(c, id), onClick: () => copyItemLink(c, id) },
    agentTrust.has(i.key) ? { action: 'agent-untrust', icon: 'shield', label: t('KI-Freigabe entziehen'), onClick: async () => {
      const agents = agentTrust.get(i.key).join(', ');
      if (!(await confirmDialog(t('KI-Freigabe entziehen'), t('„{agents}“ liest „{title}“ bisher ohne Rückfrage. Danach fragt Keevault wieder nach.', { agents, title: i.title }), { confirmLabel: t('Entziehen') }))) return;
      await call('mcpUntrust', containerId, id);
      await loadAgentTrust();
      toast(t('KI-Freigabe entzogen'));
    } } : null,
    { action: 'delete', icon: 'trash', label: t('Löschen'), danger: true, disabled: !canWrite, onClick: async () => {
      if (!(await confirmDialog(t('Eintrag löschen'), `${t('„{title}“ löschen?', { title: i.title })} ${await deleteNotice(c)}`, { confirmLabel: t('Löschen'), danger: true }))) return;
      await call('delete', containerId, id);
      if (ui.selected === i.key) ui.selected = null;
      toast(t('In den Papierkorb verschoben'));
      await reloadAll();
    } },
  ];
}

/** Copy in the same vault and folder (without passkeys); the copy is selected afterwards. */
export async function duplicateItem(containerId, id) {
  try {
    const copyItem = await call('duplicate', containerId, id);
    await reloadAll();
    ui.selected = `${containerId}/${copyItem.id}`;
    ui.editing = null;
    renderList();
    renderDetail();
    toast(t('Kopie angelegt: {title}', { title: copyItem.title }));
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function toggleFavorite(i) {
  const [containerId, id] = splitKey(i.key);
  try {
    const item = await call('item', containerId, id);
    try {
      await call('save', containerId, { ...item, favorite: !item.favorite }, item.version);
    } catch (e) {
      if (e.name !== 'ConflictError') throw e;
      if (!(await conflictDialog(containerId, item, { ...item, favorite: !item.favorite }))) return;
    }
    toast(item.favorite ? t('Aus Favoriten entfernt') : t('Zu Favoriten hinzugefügt'));
    await reloadAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/**
 * Someone else saved the entry while it was being edited: show who and when, then let the user choose.
 * Returns the saved item, or null (keep editing / reloaded).
 */
export async function conflictDialog(containerId, mine, next) {
  let current = null;
  try {
    current = await call('item', containerId, mine.id);
  } catch {
    // Deleted meanwhile: only "save anyway" or cancel make sense.
  }
  const changed = current ? ['title', 'username', 'password', 'urls', 'notes', 'totp', 'folder', 'fields']
    .filter((f) => JSON.stringify(current[f] ?? null) !== JSON.stringify(mine[f] ?? null)) : [];
  return new Promise((resolve) => {
    modal(t('Eintrag wurde inzwischen geändert'), h('div', {},
      notice(current
        ? t('„{title}“ wurde nach dem Öffnen von {who} geändert ({when}). Deine Änderungen sind noch nicht gespeichert.', {
          title: current.title, who: current.updatedBy || t('jemand anderem'), when: formatDateTime(current.updated),
        })
        : t('Der Eintrag wurde inzwischen gelöscht. Deine Änderungen sind noch nicht gespeichert.'), 'warn'),
      changed.length ? h('p', { class: 'muted' }, t('Dort geändert: {fields}', { fields: changed.map((f) => t(FIELD_LABELS[f] || f)).join(', ') })) : null), [
      { label: t('Weiter bearbeiten'), onClick: () => resolve(null) },
      current ? { label: t('Neuen Stand anzeigen (meine Änderungen verwerfen)'), onClick: async () => {
        ui.editing = null;
        await reloadAll();
        resolve(null);
      } } : null,
      { label: t('Meine Änderungen trotzdem speichern'), danger: true, onClick: async () => {
        resolve(await call('save', containerId, next, current?.version));
      } },
    ].filter(Boolean));
  });
}

export async function historyDialog(item) {
  let versions;
  try {
    versions = await call('history', item.containerId, item.id);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  modal(t('Verlauf – {title}', { title: item.title }), h('div', {}, ...versions.map((v, i) => h('div', { class: 'member' },
    icon('history'),
    h('div', { class: 'row-text' },
      h('div', { class: 'row-title' }, formatDateTime(v.updated), i === 0 ? h('span', { class: 'badge accent' }, t('aktuell')) : null),
      h('div', { class: 'row-sub mono' }, String(v.version).slice(0, 16))),
    i > 0 ? h('button', { type: 'button', class: 'btn small', onclick: () => showVersion(item, v) }, t('Anzeigen')) : null))),
  [{ label: t('Schließen') }]);
}

async function showVersion(item, v) {
  let old;
  try {
    old = await call('version', item.containerId, item.id, v.version);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  modal(t('Version vom {date}', { date: formatDateTime(v.updated) }), itemDetail(old, { copy, openUrl, containerName }), [
    { label: t('Schließen') },
    { label: t('Diese Version wiederherstellen'), primary: true, onClick: async () => {
      await call('restoreVersion', item.containerId, item.id, v.version);
      toast(t('Version wiederhergestellt'));
      await reloadAll();
    } },
  ]);
}

export function moveDialog(item) {
  const targets = writableContainers().filter((c) => c.id !== item.containerId && !(c.personal && !st.containers.find((x) => x.id === item.containerId)?.personal));
  if (!targets.length) {
    toast(t('Kein anderer Tresor mit Schreibrechten'), 'error');
    return;
  }
  const target = h('select', {}, ...targets.map((c) => h('option', { value: c.id }, c.name)));
  modal(t('Eintrag verschieben'), h('div', {},
    field(t('„{title}“ verschieben nach', { title: item.title }), target),
    h('p', { class: 'muted small' }, t('Der Eintrag wird im Ziel neu angelegt und in der Quelle gelöscht. Der bisherige Verlauf bleibt bis zum Ende der Aufbewahrungsfrist in der Quelle.'))), [
    { label: t('Abbrechen') },
    { label: t('Verschieben'), primary: true, onClick: async () => {
      const saved = await call('move', item.containerId, target.value, item.id);
      ui.selected = saved.key;
      toast(saved.droppedLinks?.length ? droppedLinksText(saved) : t('Verschoben'));
      await reloadAll();
    } },
  ]);
}

export function openImport(container) {
  importDialog({
    containers: writableContainers(),
    defaultContainer: container?.id || st.settings.defaultContainer,
    existing: async (containerId) => items.filter((i) => i.containerId === containerId),
    save: async (containerId, list, onProgress, extra) => {
      const listener = (ev) => onProgress(ev.done, ev.total);
      progressListeners.add(listener);
      try {
        return await call('importItems', containerId, list, extra);
      } finally {
        progressListeners.delete(listener);
      }
    },
    download: () => call('saveSampleCsv').then((p) => p && toast(t('Gespeichert'))),
    openKdbx: (bytes, creds) => call('decryptKdbx', bytes, creds),
    onDone: () => reloadAll(),
  });
}

/** What the report dialogs need from the app. */
/** Admin mode (#307): the assets and linked logins that use this login, each opened with a click. */
export async function linkedAssetsDialog(item) {
  const USES = { rdp: 'RDP-Konto', teamviewer: 'TeamViewer-Passwort', bastionLogin: 'Microsoft-Anmeldung (Bastion)', bastionVm: 'Konto auf dem Server (Bastion)', login: 'Verknüpfter Login' };
  const list = h('div', { class: 'link-pick-list linked-assets-list' }, h('span', { class: 'spinner' }));
  const { close } = modal(t('Verknüpfte Assets von „{title}“', { title: item.title }), list, [{ label: t('Schließen') }]);
  let entries = [];
  try {
    entries = await call('linkedEntries', item.containerId, item.id);
  } catch (e) {
    setChildren(list, notice(e.message));
    return;
  }
  setChildren(list, entries.length ? entries.map((e) => h('button', { type: 'button', class: 'link-pick-row', dataset: { key: e.key }, onclick: () => {
    close();
    // Assets live on the assets side of admin mode, logins on the passwords side.
    ui.devices = e.type === 'server';
    Object.assign(ui, { view: 'container', containerId: e.containerId, folder: items.find((x) => x.key === e.key)?.folder || '', folderOf: e.containerId, selected: e.key, editing: null });
    render();
  } }, itemAvatar(items.find((x) => x.key === e.key) || { key: e.key, title: e.title }),
  h('span', { class: 'link-pick-main' }, h('span', { class: 'link-pick-text' }, e.title), h('span', { class: 'link-pick-sub' }, e.uses.map((u) => t(USES[u])).join(' · ')))))
    : [h('p', { class: 'muted' }, t('Kein Asset und kein Login verwendet diesen Eintrag.'))]);
}
