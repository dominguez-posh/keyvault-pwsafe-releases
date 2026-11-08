// The details pane: showing an entry and editing it.

import { h, icon, toast, confirmDialog } from '../../../extension/core/dom.js';
import { itemDetail, itemForm } from '../../../extension/core/ui-item.js';
import { t } from '../../../extension/core/i18n.js';
import { resolveLogin } from '../../../extension/core/model.js';
import { buildItemLink } from '../../../extension/core/links.js';
import { call } from './ipc.js';
import { panes } from './layout.js';
import { items, st, ui } from './state.js';
import { choiceName, containerName, copy, notice, openUrl, writable, writableContainers } from './helpers.js';
import { ADMIN_LINKS, connectServer, movePasskeyDialog, openAdminLink } from './admin-tools.js';
import { DRAG_PASSKEY, draggedPasskey, setDraggedPasskey } from './dragdrop.js';
import { changelogDialog } from './file-vaults.js';
import { icons, isMicrosoftSummary, itemAvatar } from './icons.js';
import { conflictDialog, duplicateItem, historyDialog, linkedAssetsDialog, moveDialog, showVersion, toggleFavorite } from './item-actions.js';
import { copyItemLink } from './item-links.js';
import { placeholderMark } from './main-menu.js';
import { contextMenu } from './menus.js';
import { adminMode, folderList, modeItems } from './modes.js';
import { renderMultiSelection, selectionSize } from './multi.js';
import { noteCreator } from './private.js';
import { reloadAll } from './shell.js';
import { deleteNotice } from './trash.js';
import { licenses } from './vault-dialogs.js';
import { featureAllowed } from './vault-menu.js';

export const splitKey = (key) => {
  const i = key.indexOf('/');
  return [key.slice(0, i), key.slice(i + 1)];
};

/** template: preset values of a login template (entryTemplate in core/model.js). */
export function newItem(type = 'login', template = null) {
  if (!writableContainers().length) {
    toast(t('Kein Tresor mit Schreibrechten – zuerst einen Tresor hinzufügen, erstellen oder entsperren'), 'error');
    return;
  }
  ui.newType = type;
  ui.newTemplate = template;
  ui.editing = 'new';
  ui.editingItem = null;
  renderDetail();
}

export async function renderDetail() {
  const pane = panes.detail;
  call('selectItem', ui.selected).catch(() => {});
  if (ui.editing) return renderEditor();
  if (selectionSize() > 1) return renderMultiSelection();
  if (!ui.selected) {
    pane.replaceChildren(h('div', { class: 'placeholder' }, placeholderMark(), h('p', {}, t('Wähle einen Eintrag aus oder lege einen neuen an.'))));
    return undefined;
  }
  const key = ui.selected;
  const [containerId, id] = splitKey(key);
  pane.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
  let item;
  try {
    item = await call('item', containerId, id);
    noteCreator(item); // #476: "Nur für mich" only for own entries
  } catch (e) {
    pane.replaceChildren(notice(e.message));
    return undefined;
  }
  // Linked login (domain or Microsoft login): shown and copied with the linked values; edited as stored (no copy).
  const shown = await resolveLogin(item, (c, i) => call('item', c, i));
  if (ui.selected !== key || ui.editing) return undefined;
  const canWrite = writable(st.containers.find((c) => c.id === containerId) || {});
  // #451: the button only when at least one asset or login uses this login.
  const hasLinkedAssets = adminMode() && shown.type === 'login'
    && (await call('linkedEntries', containerId, id).then((e) => e.length > 0, () => false));
  if (ui.selected !== key || ui.editing) return undefined;
  pane.replaceChildren(itemDetail(shown, {
    copy,
    hoverActions: true,
    // Menu "Type into window": the existing auto-type of the selected entry (u = user name, p = password).
    typeInto: (what) => call('autoType', containerId, id, what).catch((e) => toast(e.message, 'error')),
    // Linked to a Microsoft login: the website opens; on Microsoft's sign-in the bar offers the accounts (#425).
    openUrl: shown.linked?.microsoft ? (u) => call('openWithMicrosoft', { containerId, id, url: u })
      .then(() => toast(t('Geöffnet – bei Microsoft das Konto in der Keevault-Leiste wählen')), (e) => toast(e.message, 'error')) : openUrl,
    containerName,
    connect: (it, method) => connectServer(it.containerId, it.id, method),
    adminLinks: st.settings?.adminTools === true ? ADMIN_LINKS.map((l) => ({ ...l, open: (it) => openAdminLink(l, `${it.containerId}/${it.id}`) })) : null,
    // Foot of the entry: "Last edited" unfolds into the version timeline (#450).
    history: { load: () => call('history', containerId, id), open: (v) => showVersion(shown, v) },
    showLinkedAssets: hasLinkedAssets ? (it) => linkedAssetsDialog(it) : null,
    linkTitle,
    saveFile: async (name, data) => {
      try {
        const path = await call('saveCertificate', name, data);
        if (path) toast(t('Gespeichert: {path}', { path }));
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    // "⋯" in the head opens the same menu as a right-click in the list.
    menu: (anchor, items, { below = false } = {}) => {
      const r = anchor.getBoundingClientRect();
      if (below) return contextMenu({ preventDefault() {}, clientX: Math.max(8, r.right - 240), clientY: r.bottom + 6 }, items);
      // The toolbar floats at the bottom: the menu opens upwards, right above it.
      const height = items.reduce((sum, x) => sum + (x === '-' ? 9 : 34), 10);
      contextMenu({ preventDefault() {}, clientX: Math.max(8, r.right - 240), clientY: Math.max(8, r.top - height - 6) }, items);
    },
    actions: [
      canWrite ? { action: 'edit', icon: 'edit', label: t('Bearbeiten'), primary: true, onClick: () => {
        ui.editing = 'edit';
        ui.editingItem = item;
        renderDetail();
      } } : null,
      canWrite ? { icon: 'star', quick: true, on: !!item.favorite, label: item.favorite ? t('Aus Favoriten entfernen') : t('Zu Favoriten hinzufügen'), onClick: () => toggleFavorite(item) } : null,
      canWrite ? { action: 'move', icon: 'move', label: t('Verschieben'), onClick: () => moveDialog(item) } : null,
      canWrite ? { action: 'duplicate', icon: 'copy', label: t('Duplizieren'), onClick: () => duplicateItem(containerId, id) } : null,
      { action: 'history', icon: 'history', label: t('Verlauf'), onClick: () => historyDialog(item) },
      buildItemLink(st.containers.find((c) => c.id === containerId), id)
        ? { icon: 'link', quick: true, label: t('Link kopieren'), onClick: () => copyItemLink(st.containers.find((c) => c.id === containerId), id) } : null,
      st.containers.find((c) => c.id === containerId)?.secure
        ? { icon: 'clock', label: t('Änderungsprotokoll'), onClick: () => changelogDialog(st.containers.find((c) => c.id === containerId), id) } : null,
      canWrite ? { action: 'delete', icon: 'trash', label: t('Löschen'), danger: true, onClick: async () => {
        if (!(await confirmDialog(t('Eintrag löschen'), `${t('„{title}“ löschen?', { title: item.title })} ${await deleteNotice(st.containers.find((x) => x.id === containerId))}`, { confirmLabel: t('Löschen'), danger: true }))) return;
        try {
          await call('delete', containerId, id);
          ui.selected = null;
          toast(t('In den Papierkorb verschoben'));
          await reloadAll();
        } catch (e) {
          toast(e.message, 'error');
        }
      } } : null,
    ].filter(Boolean),
  }));
  return undefined;
}

/** Logins a server entry can link to (accounts for RDP, TeamViewer, Bastion); Microsoft admin accounts marked. */
const linkOptions = () => items.filter((i) => i.type === 'login')
  // avatar: the entry's own icon or logo as in the list (#32), loaded the same way.
  .map((i) => ({ key: i.key, containerId: i.containerId, title: i.title, username: i.username, container: containerName(i.containerId), msAdmin: !!i.msAdmin, loginLinked: !!i.loginLinked, avatar: () => itemAvatar(i),
    // Filters of the pickers (#312).
    microsoft: isMicrosoftSummary(i), passkey: !!i.rpIds?.length }))
  .sort((a, b) => a.title.localeCompare(b.title));

function linkTitle(key) {
  const i = items.find((x) => x.key === key);
  return i ? [i.title, i.username, containerName(i.containerId)].filter(Boolean).join(' · ') : '';
}

function renderEditor() {
  const isNew = ui.editing === 'new';
  const item = isNew ? { type: ui.newType || 'login', urls: [], ...ui.newTemplate, password: ui.newPassword || '' } : ui.editingItem;
  ui.newPassword = '';
  ui.newTemplate = null;
  const targets = writableContainers();
  const folderTarget = isNew ? ui.containerId : item.containerId;
  const knownFolders = [...new Set([...folderList(folderTarget), ...modeItems(folderTarget).map((i) => i.folder).filter(Boolean)])].sort();
  const folderContainer = st.containers.find((c) => c.id === folderTarget);
  const form = itemForm(item, {
    // TOTP: the setup QR code from the screen (#492), read in the main process.
    scanQr: () => call('scanScreenQr'), scanQrScreen: true,
    // Moving a passkey: edit mode only (#453).
    onMovePasskey: (passkey) => movePasskeyDialog(item, passkey),
    passkeyDrag: (e, passkey) => {
      e.stopPropagation();
      setDraggedPasskey({ from: `${item.containerId}/${item.id}`, credentialId: passkey.credentialId });
      e.dataTransfer.setData(DRAG_PASSKEY, JSON.stringify(draggedPasskey));
      e.dataTransfer.effectAllowed = 'move';
    },
    passkeyDragEnd: () => { setDraggedPasskey(null); },
    isNew,
    linkOptions: linkOptions(),
    devices: adminMode(),
    folders: knownFolders,
    // Without the "folders" function only existing folders can be chosen (no new ones by typing).
    folderFree: !folderContainer || featureAllowed(folderContainer, 'folders'),
    typeFixed: isNew,
    defaultFolder: ui.containerId ? ui.folder : '',
    containers: isNew ? targets : st.containers.map((c) => ({ id: c.id, name: choiceName(c) })),
    containerId: isNew
      ? [ui.containerId, st.settings.defaultContainer].find((id) => targets.some((c) => c.id === id)) || targets[0]?.id
      : item.containerId,
    onCancel: () => {
      ui.editing = null;
      renderDetail();
    },
    onSave: async (next, containerId) => {
      let saved;
      try {
        saved = await call('save', containerId, next, isNew ? undefined : item.version);
      } catch (e) {
        if (e.name !== 'ConflictError' || isNew) throw e;
        saved = await conflictDialog(containerId, item, next);
        if (!saved) return;
      }
      toast(t('Gespeichert'));
      icons.set(saved.key, saved.icon || '');
      licenses.delete(containerId);
      ui.editing = null;
      ui.selected = saved.key;
      await reloadAll();
    },
  });
  // Save and cancel also at the top, so long entries need no scrolling to the buttons at the end.
  const topSave = h('button', { type: 'button', class: 'btn primary', title: t('Speichern (Strg+S)'), onclick: () => form.requestSubmit() }, icon('check'), t('Speichern'));
  const topCancel = h('button', { type: 'button', class: 'btn', onclick: () => { ui.editing = null; renderDetail(); } }, t('Abbrechen'));
  form.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  panes.detail.replaceChildren(h('div', { class: 'editor' },
    h('div', { class: 'editor-head' }, h('h2', {}, isNew ? t('Neuer Eintrag') : t('Eintrag bearbeiten')), h('div', { class: 'actions' }, topSave, topCancel)),
    form));
}
