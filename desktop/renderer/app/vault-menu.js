// The menu of a vault (right click, ⋯): every function of a vault and when it is offered.

import { h, icon, iconButton, setChildren, toast, modal, confirmDialog, formatDateTime } from '../../../extension/core/dom.js';
import { manageDialog, enableDialog } from '../../../extension/core/ui-protect.js';
import { t } from '../../../extension/core/i18n.js';
import { healthDialog } from '../reports.js';
import { call } from './ipc.js';
import { explicitFolders, items, logos, st, ui } from './state.js';
import { copy } from './helpers.js';
import { mcpScopeAction } from './agents.js';
import { backupDialog, restoreDialog } from './backup.js';
import { changelogDialog, createFileDialog, membersDialog, migrateDialog } from './file-vaults.js';
import { newFolderDialog } from './folders.js';
import { reportCtx } from './health.js';
import { icons } from './icons.js';
import { openImport } from './item-actions.js';
import { personalWizard } from './personal.js';
import { protectCtx } from './protection.js';
import { shareDialog } from './share.js';
import { reloadAll } from './shell.js';
import { openFile } from './start.js';
import { trashDialog } from './trash.js';
import { exportDialog, licenseDialog, licenses, logoDialog, renameContainerDialog, vaultSettingsDialog } from './vault-dialogs.js';
import { addContainerDialog, vaultWizard } from './vault-wizard.js';

/** Problems with the access (shown as a tag right of the name); the regular levels are a symbol before it (roleMark). */
export function accessBadge(c) {
  if (c.error) return h('span', { class: 'badge danger' }, t('Kein Zugriff'));
  if (c.kind === 'file') return null;
  if (!c.access) return h('span', { class: 'badge' }, t('Zugriff unbekannt'));
  if (!c.access.read && !c.access.manage) return h('span', { class: 'badge warn' }, t('Ohne Datenzugriff'));
  return null;
}

/** Symbol left of the vault name for the own permission – eye, pen, shield, crown; hover spells it out. */
export function roleMark(c) {
  const mark = (name, level, text) => h('span', { class: `role-mark role-${level}`, title: text, 'aria-label': text, role: 'img' }, icon(name, 18));
  const owner = (text) => mark('crown', 'owner', text);
  const admin = (text) => mark('shield', 'admin', text);
  const write = (text) => mark('edit', 'write', text);
  const read = (text) => mark('eye', 'read', text);
  if (c.error || c.locked && c.kind !== 'file') return null;
  if (c.personal) return owner(t('Dein persönlicher Tresor – nur du hast Zugriff'));
  if (c.kind === 'file' && c.secure && c.role) {
    if (c.role === 'admin') return owner(t('Admin: lesen, bearbeiten und Mitglieder einladen bzw. Berechtigungen vergeben'));
    if (c.role === 'editor') return write(t('Bearbeiten: Einträge lesen und ändern'));
    return read(t('Nur lesen: Einträge ansehen und kopieren, nichts ändern'));
  }
  if (c.kind === 'file') return write(t('Datei-Tresor: lesen und bearbeiten ({path})', { path: c.path || '' }));
  const x = c.access;
  if (!x) return null;
  if (x.manage) return owner(x.read ? t('Besitzer: lesen, bearbeiten, verwalten und Berechtigungen vergeben') : t('Besitzer: darf Berechtigungen vergeben, hat selbst aber keinen Datenzugriff'));
  if (x.admin) return admin(t('Verwalten: lesen, bearbeiten und Tresor-Einstellungen festlegen'));
  if (x.write) return write(t('Bearbeiten: Einträge lesen und ändern'));
  if (x.read) return read(t('Nur lesen: Einträge ansehen und kopieren, nichts ändern'));
  return null;
}

export async function refreshContainer(c, button) {
  if (button) button.disabled = true;
  try {
    await call('refreshContainer', c.id);
    explicitFolders.delete(c.id);
    logos.delete(c.id);
    licenses.delete(c.id);
    for (const key of [...icons.keys()]) if (key.startsWith(`${c.id}/`)) icons.delete(key);
    await reloadAll();
    toast(t('Aktualisiert'));
  } catch (e) {
    toast(e.message, 'error');
  }
  if (button) button.disabled = false;
}

/** Facts about a Key Vault: Azure details, admins, link to the portal. */
async function infoDialog(c) {
  const body = h('div', {}, h('p', {}, h('span', { class: 'spinner' }), ' ', t('Informationen werden geladen …')));
  modal(t('Tresor-Infos: {name}', { name: c.name }), body, [{ label: t('Schließen') }]);
  let info;
  try {
    info = await call('vaultInfo', c.id);
  } catch (e) {
    body.replaceChildren(h('p', { class: 'notice' }, e.message));
    return;
  }
  const row = (label, value, extra) => (value ? h('tr', {}, h('th', {}, label), h('td', {}, value, extra || null)) : null);
  const copyBtn = (text) => iconButton('copy', t('Kopieren'), () => copy(text, t('Kopiert')));
  const yesNo = (v) => (v ? t('ja') : t('nein'));
  setChildren(body,
    h('table', { class: 'info-table' },
      row(t('Adresse'), c.vaultUrl, copyBtn(c.vaultUrl)),
      row(t('Einträge'), String(c.count ?? items.filter((i) => i.containerId === c.id).length)),
      row(t('Erstellt'), info.createdAt ? `${formatDateTime(info.createdAt)}${info.createdBy ? ` · ${info.createdBy}` : ''}` : ''),
      row(t('Zuletzt geändert'), info.modifiedAt ? `${formatDateTime(info.modifiedAt)}${info.modifiedBy ? ` · ${info.modifiedBy}` : ''}` : ''),
      row(t('Administratoren'), info.admins.length ? info.admins.map((a) => a.detail ? `${a.displayName} (${a.detail})` : a.displayName).join(', ') : t('keine Datenrolle „Verwalten“ vergeben')),
      row(t('Tenant'), info.tenantId, copyBtn(info.tenantId)),
      row(t('Subscription'), info.subscriptionName ? `${info.subscriptionName} (${info.subscriptionId})` : info.subscriptionId),
      row(t('Ressourcengruppe'), info.resourceGroup),
      row(t('Region'), info.location),
      row(t('Berechtigungsmodell'), info.rbac ? t('Azure RBAC') : t('Zugriffsrichtlinien (nicht unterstützt)')),
      // Which metadata is readable without the entry itself (tags): titles, user names, websites, folders – unless the vault is protected.
      row(t('Metadaten'), c.protected ? t('verschlüsselt (zusätzlicher Schutz)') : t('Titel, Benutzername, Websites und Ordner stehen als Tags im Klartext – lesbar für jede Rolle mit Metadaten-Leserecht (z. B. Key Vault Reader). Für sensible Tresore: Rechtsklick → „Zusätzlich schützen“.')),
      row(t('Papierkorb (Soft Delete)'), `${yesNo(info.softDelete)}${info.retentionDays ? t(', {days} Tage Aufbewahrung', { days: info.retentionDays }) : ''}`),
      row(t('Schutz vor endgültigem Löschen'), yesNo(info.purgeProtection)),
      row(t('SKU'), info.sku)),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => call('openExternal', info.portalUrl) }, icon('link'), t('Im Azure-Portal öffnen')),
      h('button', { type: 'button', class: 'btn', onclick: () => copy(info.resourceId, t('Kopiert')) }, icon('copy'), t('Ressourcen-ID kopieren'))));
}

/** All functions of a container (right-click menu in the sidebar). */
/**
 * Vault settings: Key Vault admins may use every function; everyone else only what an admin enabled (restrictive
 * default). File vaults have their own roles and are not affected. The desktop main process enforces the same.
 */
export const featureAllowed = (c, feature) => c.kind !== 'keyvault' || !!c.access?.admin || c.policy?.[feature] === true;

// The vault menu keeps every function but folds the rarely used ones into two submenus.
const VAULT_GROUPS = [
  { action: 'group-manage', icon: 'settings', label: 'Verwaltung', members: ['vault-settings', 'mcp-scope', 'license', 'logo', 'rename', 'migrate', 'changelog'] },
  { action: 'group-data', icon: 'download', label: 'Daten', members: ['import', 'export', 'backup', 'restore', 'trash'] },
];

function groupMenu(actions) {
  const out = [];
  for (const a of actions.filter(Boolean)) {
    const g = a !== '-' && VAULT_GROUPS.find((x) => x.members.includes(a.action));
    if (!g) {
      out.push(a);
      continue;
    }
    let node = out.find((x) => x !== '-' && x.action === g.action);
    if (!node) {
      node = { action: g.action, icon: g.icon, label: t(g.label), children: [] };
      out.push(node);
    }
    node.children.push(a);
  }
  // No separators at the ends or twice in a row.
  return out.filter((x, i, arr) => !(x === '-' && (i === 0 || i === arr.length - 1 || arr[i - 1] === '-')));
}

/** All functions of a container (right-click menu in the sidebar). */
export function containerActions(c) {
  return groupMenu(containerActionsFlat(c));
}

function containerActionsFlat(c) {
  const isFile = c.kind === 'file';
  const ready = !c.error && !c.locked;
  const canWrite = ready && c.access?.write !== false;
  const may = (feature) => featureAllowed(c, feature);
  const protection = c.secure
    ? { action: 'members', icon: 'users', label: t('Benutzer und Freigabe'), disabled: !!c.error, onClick: () => (c.locked ? toast(t('Zuerst entsperren')) : membersDialog(c)) }
    : isFile || c.protected
      ? { action: 'protection', icon: 'shield', label: t('Schutz und Benutzer'), disabled: !!c.error, onClick: () => (c.locked ? toast(t('Zuerst entsperren')) : manageDialog(c, protectCtx, () => reloadAll())) }
      : may('protection') ? { action: 'protection', icon: 'shield', label: t('Zusätzlich schützen (Masterpasswort/Passkey)'), disabled: !canWrite, onClick: () => enableDialog(c, protectCtx, () => reloadAll()) } : null;
  const settings = !isFile && (c.access?.admin || c.access?.manage)
    ? { action: 'vault-settings', icon: 'settings', label: t('Tresor-Einstellungen (Admin)'), disabled: !!c.error, onClick: () => vaultSettingsDialog(c) } : null;
  return [
    { action: 'refresh', icon: 'refresh', label: t('Aktualisieren'), disabled: c.locked && !c.error, onClick: () => refreshContainer(c) },
    '-',
    isFile ? null : { action: 'share', icon: 'users', label: t('Freigeben'), onClick: () => shareDialog(c) },
    protection,
    isFile && !c.secure && ready ? { action: 'migrate', icon: 'key', label: t('In abgesichertes Format umwandeln (nur Passkey)'), onClick: () => migrateDialog(c) } : null,
    c.secure ? { action: 'changelog', icon: 'clock', label: t('Änderungsprotokoll'), disabled: !ready, onClick: () => changelogDialog(c) } : null,
    settings,
    mcpScopeAction(c.id, ''),
    c.kind === 'keyvault' ? { action: 'info', icon: 'info', label: t('Infos'), disabled: !!c.error, onClick: () => infoDialog(c) } : null,
    c.kind === 'keyvault' || c.kind === 'file' ? { action: 'health', icon: 'shield', label: t('Passwort-Check'), disabled: !ready, onClick: () => healthDialog(reportCtx(c.id)) } : null,
    '-',
    may('folders') ? { action: 'folder', icon: 'folder-plus', label: t('Neuer Ordner'), disabled: !canWrite, onClick: () => newFolderDialog(c) } : null,
    may('logo') ? { action: 'logo', icon: 'image', label: t('Logo des Tresors'), disabled: !canWrite, onClick: () => logoDialog(c) } : null,
    may('rename') ? { action: 'rename', icon: 'edit', label: t('Umbenennen'), disabled: !!c.error || (isFile && !ready), onClick: () => renameContainerDialog(c) } : null,
    may('import') ? { action: 'import', icon: 'upload', label: t('Importieren'), disabled: !canWrite, onClick: () => openImport(c) } : null,
    !isFile && may('export') ? { action: 'export', icon: 'download', label: t('Einträge exportieren (CSV)'), disabled: !ready, onClick: () => exportDialog(c) } : null,
    { action: 'trash', icon: 'trash', label: t('Papierkorb'), disabled: !ready, onClick: () => trashDialog(c) },
    { action: 'license', icon: 'key', label: t('Lizenz'), disabled: !ready, onClick: () => licenseDialog(c) },
    isFile ? null : { action: 'backup', icon: 'download', label: t('Backup erstellen (Owner)'), disabled: !!c.error, onClick: () => backupDialog(c) },
    isFile ? null : { action: 'restore', icon: 'history', label: t('Backup wiederherstellen (Owner)'), disabled: !!c.error, onClick: () => restoreDialog(c) },
    '-',
    isFile
      ? { action: 'explorer', icon: 'folder', label: t('Im Explorer zeigen'), onClick: () => call('showFile', c.id) }
      : { action: 'invite', icon: 'link', label: t('Einladungslink kopieren'), onClick: () => copy(call('invite', c.id), t('Einladungslink')) },
    ready && (c.protected || isFile) ? { action: 'lock', icon: 'lock', label: t('Tresor sperren'), onClick: async () => {
      await call('lockContainer', c.id);
      await reloadAll();
    } } : null,
    c.sources?.includes('policy') ? null : { action: 'remove', icon: 'x', label: t('Aus der Liste entfernen'), danger: true, onClick: async () => {
      if (!(await confirmDialog(t('Tresor entfernen'), isFile
        ? t('„{name}“ aus der Liste entfernen? Die Datei bleibt erhalten.', { name: c.name })
        : t('„{name}“ aus der Liste entfernen? Der Key Vault und seine Daten bleiben unverändert.', { name: c.name }), { confirmLabel: t('Entfernen') }))) return;
      await call('removeContainer', c.id);
      ui.containerId = null;
      await reloadAll();
    } },
  ];
}

export function containerMenu() {
  const option = (iconName, title, text, onClick, disabled) => h('button', { class: 'option-card', disabled, onclick: () => {
    close();
    onClick();
  } }, icon(iconName, 20), h('div', {}, h('b', {}, title), h('div', { class: 'muted small' }, text)));
  const { close } = modal(t('Tresor hinzufügen'), h('div', {},
    (st.settings.personalVaults || []).length ? null : option('user', t('Persönlicher Tresor (kostenlos)'), t('Nur für dich, verschlüsselt in deinem OneDrive (oder einem anderen synchronisierten Ordner bzw. Netzlaufwerk). Masterpasswort, App-PIN, optional FIDO-Stick.'), personalWizard),
    option('note', t('Neuer Datei-Tresor'), t('Verschlüsselte Datei wie bei KeePass, abgesichert mit Passkey und/oder Masterpasswort.'), createFileDialog),
    option('folder', t('Datei-Tresor öffnen'), t('Vorhandene .kvpws-Datei, z. B. von einem Netzlaufwerk.'), openFile),
    option('link', t('Vorhandenen Key Vault hinzufügen'), st.signedIn
      ? t('Aus deinen Key Vaults wählen oder per Adresse/Einladungslink. Der Zugriff kommt über Azure-Rollen.')
      : t('Key Vault per Adresse oder Einladungslink. Der Zugriff kommt über Azure-Rollen.'), () => addContainerDialog()),
    option('plus', t('Neuen Key-Vault-Tresor erstellen'), st.signedIn
      ? t('Legt einen Key Vault in einem Azure-Abonnement an, z. B. für ein Team.')
      : t('Der Assistent führt Schritt für Schritt durch Anmeldung, Ort, Zugriff und Notfallkonten.'), () => vaultWizard({ intro: false }))), []);
}
