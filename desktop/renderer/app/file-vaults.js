// File vaults: creating, unlocking with a passkey, members and roles, change log.

import { h, icon, setChildren, toast, modal, confirmDialog, formatDateTime } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { ROLE_NAMES, FILE_ROLES } from '../../../extension/core/members.js';
import { call } from './ipc.js';
import { st, ui } from './state.js';
import { field, notice } from './helpers.js';
import { reloadAll, render } from './shell.js';

const defaultEmail = () => st.settings.fileEmail || st.account?.username || '';

function authenticatorSelect() {
  return h('select', {},
    h('option', { value: 'platform' }, t('Windows Hello auf diesem Gerät (PIN, Gesicht, Fingerabdruck)')),
    h('option', { value: 'cross-platform' }, t('Sicherheitsschlüssel oder Smartphone')));
}

const PASSKEY_ONLY_HINT = 'Kein Masterpasswort, kein Wiederherstellungscode: Die Datei öffnet sich nur mit einem Passkey (oder Windows Hello). Richte danach einen zweiten Passkey oder einen zweiten Admin ein, damit die Datei nicht verloren geht.';

/** Prominent warning before a vault is stored as a local file: the file can simply be copied and taken away. */
function fileRiskBox() {
  const accept = h('input', { type: 'checkbox' });
  const box = h('div', { class: 'danger-box', role: 'alert' },
    h('h3', {}, t('⚠ Sicherheitshinweis: Der Tresor liegt als Datei auf diesem Gerät')),
    h('p', {}, t('Eine Datei lässt sich unbemerkt kopieren, per USB-Stick, E-Mail oder Cloud-Sync mitnehmen und an einem anderen Ort in Ruhe angreifen. Anders als bei Azure Key Vault gibt es kein Zugriffsprotokoll, keine zentrale Sperre und kein Entziehen von Rechten für bereits kopierte Dateien.')),
    h('ul', {},
      h('li', {}, t('Speichere die Datei nur auf verschlüsselten Laufwerken (BitLocker) oder geschützten Netzlaufwerken – nicht auf USB-Sticks, in privaten Cloud-Ordnern oder als Mail-Anhang.')),
      h('li', {}, t('Geht ein Gerät oder eine Kopie verloren: alle Passwörter darin sofort ändern.')),
      h('li', {}, t('Ohne gültigen Passkey ist die Datei nicht lesbar – geht der letzte Passkey verloren, sind die Daten weg.')),
      h('li', {}, t('Für Teams und Firmendaten empfehlen wir einen Tresor in Azure Key Vault.'))),
    h('label', { class: 'inline' }, accept, t('Ich habe den Hinweis verstanden und bin für den sicheren Speicherort der Datei verantwortlich.')));
  return { box, accepted: () => accept.checked };
}

export function createFileDialog() {
  const name = h('input', { placeholder: t('z. B. Persönlich oder Team Infrastruktur') });
  const email = h('input', { type: 'email', value: defaultEmail(), placeholder: t('name@firma.de') });
  const authenticator = authenticatorSelect();
  const risk = fileRiskBox();
  modal(t('Neuer Datei-Tresor'), h('div', {},
    risk.box,
    h('p', { class: 'muted' }, t('Alle Einträge werden in der Datei verschlüsselt. Du wirst Admin der Datei und kannst sie danach für weitere Personen freigeben – jede Person nutzt ihren eigenen Passkey.')),
    field(t('Name'), name),
    field(t('Deine E-Mail-Adresse'), email),
    field(t('Anmelden mit'), authenticator),
    notice(t(PASSKEY_ONLY_HINT), 'info')), [
    { label: t('Abbrechen') },
    { label: t('Speicherort wählen und erstellen'), primary: true, onClick: async () => {
      if (!risk.accepted()) throw new Error(t('Bitte den Sicherheitshinweis bestätigen'));
      if (!name.value.trim()) throw new Error(t('Bitte einen Namen eingeben'));
      if (!email.value.includes('@')) throw new Error(t('Bitte eine gültige E-Mail-Adresse eingeben'));
      const filePath = await call('chooseNewFile', name.value.trim());
      if (!filePath) return false;
      const r = await call('createSecureFile', { path: filePath, name: name.value.trim(), email: email.value, attachment: authenticator.value });
      ui.containerId = r.id;
      ui.view = 'container';
      await render();
      toast(t('Datei erstellt – du bist Admin. Unter „Benutzer und Freigabe“ gibst du sie für andere frei.'));
      return true;
    } },
  ]);
  setTimeout(() => name.focus(), 0);
}

export function secureUnlockPanel(c, info) {
  const status = h('div');
  const email = h('input', { type: 'email', value: defaultEmail(), placeholder: t('name@firma.de') });
  const authenticator = authenticatorSelect();
  const unlockButton = h('button', { class: 'btn primary block', onclick: async () => {
    unlockButton.disabled = true;
    setChildren(status);
    try {
      const r = await call('unlockContainerPasskey', c.id);
      if (r?.pending) {
        setChildren(status, notice(t('Deine Anfrage wartet auf die Freigabe durch einen Admin der Datei. Sicherheitscode zum Vergleichen: {code}', { code: r.safetyCode }), 'info'));
      } else {
        await reloadAll();
        if (st.platform === 'win32' && r?.platform === false && !r.hasPlatform) offerWindowsHello(c);
      }
    } catch (e) {
      setChildren(status, notice(e.message));
    }
    unlockButton.disabled = false;
  } }, icon('key'), t('Mit Passkey entsperren'));
  const requestButton = h('button', { class: 'btn block', onclick: async () => {
    requestButton.disabled = true;
    try {
      const r = await call('requestFileAccess', c.id, { email: email.value, attachment: authenticator.value });
      setChildren(status, notice(t('Anfrage gespeichert. Nenne dem Admin der Datei diesen Sicherheitscode: {code}. Nach der Freigabe entsperrst du mit deinem Passkey.', { code: r.safetyCode }), 'info'));
    } catch (e) {
      setChildren(status, notice(e.message));
    }
    requestButton.disabled = false;
  } }, icon('user'), t('Zugriff anfordern'));
  return h('div', { class: 'unlock-panel' },
    icon('shield', 40),
    h('h3', {}, t('Abgesicherte Datei')),
    h('p', { class: 'muted' }, t('Diese Datei lässt sich nur mit einem Passkey oder Windows Hello öffnen.')),
    info.passkeys.length ? unlockButton : null,
    status,
    h('details', { open: !info.passkeys.length || undefined },
      h('summary', {}, t('Noch kein Zugriff? Zugriff anfordern')),
      field(t('Deine E-Mail-Adresse'), email),
      field(t('Anmelden mit'), authenticator),
      requestButton));
}

async function offerWindowsHello(c) {
  if (!(await confirmDialog(t('Mit Windows Hello merken?'), t('Dann reicht beim nächsten Öffnen von „{name}“ deine Windows-PIN, dein Gesicht oder Fingerabdruck. Der Schlüssel bleibt an dieses Gerät gebunden.', { name: c.name }), { confirmLabel: t('Mit Windows Hello merken') }))) return;
  try {
    await call('fileMemberOp', c.id, { type: 'addCredential', attachment: 'platform' });
    toast(t('Windows Hello hinterlegt'));
  } catch (e) {
    toast(e.message, 'error');
  }
}

export function migrateDialog(c) {
  const email = h('input', { type: 'email', value: defaultEmail(), placeholder: t('name@firma.de') });
  const authenticator = authenticatorSelect();
  modal(t('In abgesichertes Format umwandeln'), h('div', {},
    h('p', { class: 'muted' }, t('Die Datei bekommt einen neuen Schlüssel und Benutzer mit Rollen. Masterpasswort, Wiederherstellungsschlüssel und Einladungen funktionieren danach nicht mehr; andere Personen fordern den Zugriff neu an. Der Verlauf alter Versionen entfällt.')),
    field(t('Deine E-Mail-Adresse'), email),
    field(t('Anmelden mit'), authenticator),
    notice(t(PASSKEY_ONLY_HINT), 'info')), [
    { label: t('Abbrechen') },
    { label: t('Umwandeln'), primary: true, onClick: async () => {
      const id = await call('migrateFile', c.id, { email: email.value, attachment: authenticator.value });
      ui.containerId = id;
      toast(t('Umgewandelt – du bist Admin der Datei'));
      await reloadAll();
    } },
  ]);
}

export async function membersDialog(c) {
  let info;
  try {
    info = await call('fileMembers', c.id);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const body = h('div', { class: 'members' });
  modal(t('Benutzer und Freigabe'), body, [{ label: t('Schließen') }]);
  const op = async (o, message) => {
    try {
      await call('fileMemberOp', c.id, o);
      if (message) toast(message);
      info = await call('fileMembers', c.id);
      draw();
      reloadAll();
    } catch (e) {
      toast(e.message, 'error');
      info = await call('fileMembers', c.id).catch(() => info);
      draw();
    }
  };
  const roleSelect = (value, onChange, disabled) => h('select', { disabled, onchange: (e) => onChange(e.target.value) },
    ...FILE_ROLES.map((r) => h('option', { value: r, selected: r === value }, t(ROLE_NAMES[r]))));
  function draw() {
    const admin = info.myRole === 'admin';
    const me = info.members.find((m) => m.me);
    const pending = info.members.filter((m) => m.status === 'pending');
    const active = info.members.filter((m) => m.status === 'active');
    const admins = active.filter((m) => m.role === 'admin');
    setChildren(body,
      h('p', { class: 'muted' }, t('Die Datei öffnet sich nur mit Passkey oder Windows Hello. Jede Person meldet sich mit ihrer E-Mail-Adresse und ihrem eigenen Passkey an; Admins geben den Zugriff frei.')),
      admins.length === 1 && me?.role === 'admin' && me.credentials?.length === 1
        ? notice(t('Es gibt keinen Wiederherstellungscode. Richte einen zweiten Passkey oder einen zweiten Admin ein, damit die Datei nicht verloren geht.'), 'warn') : null,
      admin ? h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: info.sharing, onchange: (e) => op({ type: 'sharing', enabled: e.target.checked },
        e.target.checked ? t('Freigabe aktiv – andere können jetzt Zugriff anfordern') : t('Freigabe beendet – keine neuen Anfragen')) }),
      t('Freigabe aktiv: andere Personen können mit der Datei Zugriff anfordern')) : null,
      admin && pending.length ? h('h3', {}, t('Offene Anfragen')) : null,
      admin && pending.length ? h('p', { class: 'muted small' }, t('Vergleiche den Sicherheitscode mit der Person (z. B. am Telefon), bevor du freigibst.')) : null,
      ...(admin ? pending : []).map((m) => {
        let role = 'editor';
        return h('div', { class: 'member-row' },
          h('div', { class: 'grow' }, h('b', {}, m.email), h('div', { class: 'muted small' }, t('Sicherheitscode {code}', { code: m.safetyCode }), ' · ', formatDateTime(m.requested))),
          roleSelect(role, (v) => { role = v; }),
          h('button', { class: 'btn small primary', onclick: () => op({ type: 'approve', memberId: m.id, role }, t('{email} freigegeben', { email: m.email })) }, t('Freigeben')),
          h('button', { class: 'btn small', onclick: () => op({ type: 'reject', memberId: m.id }, t('Anfrage abgelehnt')) }, t('Ablehnen')));
      }),
      h('h3', {}, t('Benutzer')),
      ...active.map((m) => h('div', { class: 'member-row' },
        h('div', { class: 'grow' }, h('b', {}, m.email, m.me ? ` (${t('du')})` : ''),
          h('div', { class: 'muted small' }, t('{count} Passkeys', { count: m.passkeyCount }), m.since ? ` · ${t('seit {date}', { date: formatDateTime(m.since) })}` : '')),
        admin ? roleSelect(m.role, (v) => op({ type: 'setRole', memberId: m.id, role: v }, t('Rolle geändert')))
          : h('span', { class: 'badge' }, t(ROLE_NAMES[m.role])),
        admin && !m.me ? h('button', { class: 'btn small danger', onclick: async () => {
          if (!(await confirmDialog(t('Benutzer entfernen'), t('{email} entfernen? Die Datei bekommt dabei einen neuen Schlüssel, damit alte Zugänge nicht mehr funktionieren.', { email: m.email }), { confirmLabel: t('Entfernen'), danger: true }))) return;
          op({ type: 'remove', memberId: m.id }, t('Entfernt – Schlüssel gewechselt'));
        } }, t('Entfernen')) : null)),
      h('h3', {}, t('Meine Passkeys')),
      ...(me?.credentials || []).map((cred) => h('div', { class: 'member-row' },
        icon(cred.platform ? 'user' : 'key', 16),
        h('div', { class: 'grow' }, cred.label || t('Passkey'), h('div', { class: 'muted small' }, formatDateTime(cred.created), cred.usable ? '' : ` · ${t('anderes Gerät')}`)),
        me.credentials.length > 1 ? h('button', { class: 'btn small', onclick: () => op({ type: 'removeCredential', credentialEntryId: cred.id }, t('Passkey entfernt')) }, t('Entfernen')) : null)),
      h('div', { class: 'actions' },
        st.platform === 'win32' ? h('button', { class: 'btn small', onclick: () => op({ type: 'addCredential', attachment: 'platform' }, t('Windows Hello hinterlegt')) }, icon('user', 14), t('Mit Windows Hello merken')) : null,
        h('button', { class: 'btn small', onclick: () => op({ type: 'addCredential', attachment: 'cross-platform' }, t('Passkey hinzugefügt')) }, icon('key', 14), t('Sicherheitsschlüssel oder Smartphone hinzufügen'))));
  }
  draw();
}

export const FIELD_LABELS = {
  type: 'Typ', title: 'Titel', username: 'Benutzername', password: 'Passwort', urls: 'Websites', notes: 'Notizen', totp: 'Einmalcode (TOTP)',
  folder: 'Ordner', favorite: 'Favorit', fields: 'Zusätzliche Felder', passkeys: 'Passkeys', tags: 'Tags',
};

function describeChange(e) {
  const title = e.title || t('Eintrag');
  switch (e.action) {
    case 'file-create': return t('Datei erstellt');
    case 'file-rename': return t('Datei umbenannt: {from} → {name}', { from: e.from, name: e.name });
    case 'file-migrate': return t('In abgesichertes Format umgewandelt ({count} Einträge)', { count: e.count });
    case 'item-create': return t('„{title}“ angelegt', { title });
    case 'item-update': {
      const fields = (e.fields || []).map((f) => t(FIELD_LABELS[f] || f)).join(', ');
      if (e.fromFolder !== undefined && e.fromFolder !== e.folder) {
        return t('„{title}“ verschoben: {from} → {to}', { title, from: e.fromFolder || '/', to: e.folder || '/' });
      }
      return fields ? t('„{title}“ geändert: {fields}', { title, fields }) : t('„{title}“ gespeichert (ohne Änderung)', { title });
    }
    case 'item-delete': return t('„{title}“ in den Papierkorb verschoben', { title });
    case 'item-restore': return t('„{title}“ wiederhergestellt', { title });
    case 'item-purge': return t('„{title}“ endgültig gelöscht', { title });
    case 'folder-create': return t('Ordner „{folder}“ angelegt', { folder: e.folder });
    case 'folder-delete': return t('Ordner „{folder}“ gelöscht', { folder: e.folder });
    case 'member-approve': return t('{target} freigegeben ({role})', { target: e.target, role: t(ROLE_NAMES[e.role] || e.role) });
    case 'member-role': return t('Rolle von {target}: {role}', { target: e.target, role: t(ROLE_NAMES[e.role] || e.role) });
    case 'member-remove': return t('{target} entfernt', { target: e.target });
    case 'member-reject': return t('Anfrage von {target} abgelehnt', { target: e.target });
    case 'sharing-on': return t('Freigabe aktiviert');
    case 'sharing-off': return t('Freigabe beendet');
    case 'passkey-add': return t('Passkey hinzugefügt ({label})', { label: e.label || '' });
    case 'passkey-remove': return t('Passkey entfernt');
    case 'key-rotate': return t('Schlüssel gewechselt (Version {version})', { version: e.keyVersion });
    case 'logo-set': return t('Logo geändert');
    case 'logo-remove': return t('Logo entfernt');
    default: return t('Eintrag nicht lesbar');
  }
}

export async function changelogDialog(c, itemId) {
  let entries;
  try {
    entries = await call('changelog', c.id, itemId);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  modal(itemId ? t('Änderungsprotokoll des Eintrags') : t('Änderungsprotokoll: {name}', { name: c.name }), h('div', { class: 'changelog' },
    entries.length ? h('ul', { class: 'log-list' }, ...entries.map((e) => h('li', { class: e.trusted ? '' : 'untrusted' },
      h('div', { class: 'log-when' }, formatDateTime(e.at)),
      h('div', { class: 'grow' }, h('div', {}, describeChange(e)), h('div', { class: 'muted small' }, e.email,
        e.trusted ? '' : ` · ${t('Signatur ungültig – Änderung wird ignoriert')}`)))))
      : h('p', { class: 'muted' }, t('Noch keine Änderungen protokolliert.'))));
}
