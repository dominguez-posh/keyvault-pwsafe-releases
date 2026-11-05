// Dialogs of a vault: license, name, logo, vault settings, CSV export.

import { h, icon, iconButton, toast, modal, formatDateTime } from '../../../extension/core/dom.js';
import { t, getLanguage } from '../../../extension/core/i18n.js';
import { pickImage, LOGO_MAX_CHARS } from '../../../extension/core/image.js';
import { call } from './ipc.js';
import { logos } from './state.js';
import { copy, field, formatDate, notice, openUrl } from './helpers.js';
import { progressLine } from './backup.js';
import { renderList } from './list.js';
import { reloadAll } from './shell.js';
import { renderSidebar } from './sidebar.js';

export async function licenseDialog(c) {
  let st0;
  try {
    st0 = await call('licenseState', c.id);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const key = h('textarea', { rows: 3, placeholder: 'KVPL-…', spellcheck: 'false' });
  const permanent = st0.licensed && !st0.expires;
  const status = permanent
    ? notice(t('Lizenziert{to} – unbegrenzt viele Einträge.', { to: st0.to ? ` (${st0.to})` : '' }), 'info')
    : st0.licensed
      ? notice(t('Befristete Lizenz{to} bis {date} – danach gilt wieder die Grenze von {limit} Einträgen.', { to: st0.to ? ` (${st0.to})` : '', date: formatDate(st0.expires), limit: st0.limit }), 'info')
      : notice(t('Ohne Lizenz: {count} von {limit} Einträgen genutzt.', { count: st0.count, limit: st0.limit }), st0.count >= st0.limit ? 'warn' : 'info');
  // Website with the request code filled in: order form and free trial (in the app's language).
  const site = getLanguage() === 'en' ? 'https://keevault.de/en/' : 'https://keevault.de/';
  const query = `?code=${encodeURIComponent(st0.code)}&vault=${encodeURIComponent(st0.vault.split('.')[0])}`;
  const links = h('div', { class: 'license-links' },
    h('button', { type: 'button', class: 'btn primary', onclick: () => openUrl(`${site}${getLanguage() === 'en' ? 'license.html' : 'lizenz.html'}${query}`) }, icon('external', 14), t('Lizenz anfragen')),
    st0.licensed ? null : h('button', { type: 'button', class: 'btn', onclick: () => openUrl(`${site}${getLanguage() === 'en' ? 'trial.html' : 'testlizenz.html'}${query}`) }, icon('external', 14), t('3 Monate kostenlos testen')));
  modal(t('Lizenz für „{name}“', { name: c.name }), h('div', {},
    status,
    st0.reason ? notice(st0.reason) : null,
    permanent ? null : h('div', {},
      h('p', { class: 'muted' }, t('Frag auf der Website unverbindlich eine Lizenz an – der Anfragecode ist schon eingetragen. Wir melden uns persönlich; der Lizenzschlüssel gilt genau für diesen Tresor.')),
      links,
      h('div', { class: 'field-row' }, h('code', { class: 'license-code' }, st0.code), iconButton('copy', t('Kopieren'), () => copy(`${st0.code}  (${st0.vault})`, t('Lizenzanfrage')))),
      h('p', { class: 'muted small' }, t('Tresor: {vault}', { vault: st0.vault })),
      field(t('Lizenzschlüssel'), key))), permanent ? [{ label: t('Schließen') }] : [
    { label: t('Abbrechen') },
    { label: t('Aktivieren'), primary: true, onClick: async () => {
      await call('setLicense', c.id, key.value);
      licenses.delete(c.id);
      toast(t('Lizenz aktiviert'));
      renderList();
    } },
  ]);
}

export function renameContainerDialog(c) {
  const name = h('input', { value: c.name });
  modal(t('Tresor umbenennen'), h('div', {},
    h('p', { class: 'muted' }, c.kind === 'file'
      ? t('Der Name wird in der Datei gespeichert und ist für alle sichtbar.')
      : t('Der Name wird als Tag am Key Vault gespeichert (dafür braucht es Schreibrechte auf die Ressource) und gilt sonst nur in deiner App.')),
    field(t('Name'), name)), [
    { label: t('Abbrechen') },
    { label: t('Umbenennen'), primary: true, onClick: async () => {
      const r = await call('renameContainer', c.id, name.value);
      if (r.warning) toast(r.warning, 'error');
      else toast(t('Umbenannt'));
      await reloadAll();
    } },
  ]);
  setTimeout(() => name.select(), 0);
}

export function logoDialog(c) {
  let logo = logos.get(c.id) || null;
  const preview = h('div', { class: 'logo-preview' });
  const draw = () => preview.replaceChildren(logo ? h('img', { src: logo, alt: '' }) : h('span', { class: 'muted' }, t('Kein Logo')));
  draw();
  modal(t('Logo von „{name}“', { name: c.name }), h('div', {},
    h('p', { class: 'muted' }, t('Z. B. das Logo des Kunden. Es wird verkleinert und im Tresor gespeichert (Key Vault: als Secret, bei Schutz verschlüsselt; Datei: verschlüsselt). Alle mit Zugriff sehen es.')),
    preview,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn small', onclick: async () => {
        try {
          const url = await pickImage({ size: 128, maxChars: LOGO_MAX_CHARS });
          if (url) {
            logo = url;
            draw();
          }
        } catch (e) {
          toast(e.message, 'error');
        }
      } }, icon('image', 14), t('Bild wählen …')),
      h('button', { type: 'button', class: 'btn small', onclick: () => { logo = null; draw(); } }, t('Entfernen')))), [
    { label: t('Abbrechen') },
    { label: t('Speichern'), primary: true, onClick: async () => {
      await call('setContainerLogo', c.id, logo);
      logos.set(c.id, logo);
      toast(t('Gespeichert'));
      renderSidebar();
      renderList();
    } },
  ]);
}

const POLICY_ORDER = ['folders', 'rename', 'logo', 'import', 'export', 'protection', 'purge'];
const POLICY_TEXT = {
  folders: 'Ordner anlegen, umbenennen und löschen',
  rename: 'Tresor umbenennen',
  logo: 'Logo des Tresors ändern',
  import: 'Einträge importieren',
  export: 'Einträge exportieren (unverschlüsselt, CSV)',
  protection: 'Zusätzlichen Schutz ein- oder ausschalten',
  purge: 'Einträge endgültig aus dem Papierkorb löschen',
};

export async function vaultSettingsDialog(c) {
  let state;
  try {
    state = await call('policyState', c.id);
  } catch (e) {
    return toast(e.message, 'error');
  }
  if (!state.admin) {
    // Manage (may assign roles) but not admin: offer to take the Key Vault Administrator role.
    return modal(t('Tresor-Einstellungen'), h('div', {},
      h('p', {}, t('Die Tresor-Einstellungen ändern nur Personen mit der Azure-Rolle „Key Vault-Administrator“ auf diesem Key Vault.')),
      state.canBecomeAdmin ? notice(t('Du darfst Rollen vergeben und kannst dir die Rolle selbst geben. Sie gilt nach ein paar Minuten.'), 'info') : null), [
      { label: t('Abbrechen') },
      state.canBecomeAdmin ? { label: t('Mir die Admin-Rolle geben'), primary: true, onClick: async () => {
        await call('makeMeAdmin', c.id);
        toast(t('Rolle vergeben – nach dem Aktualisieren stehen die Einstellungen bereit'));
        await reloadAll();
        return true;
      } } : null,
    ].filter(Boolean));
  }
  const boxes = Object.fromEntries(POLICY_ORDER.map((f) => [f, h('input', { type: 'checkbox', checked: !!state.features?.[f] })]));
  modal(t('Tresor-Einstellungen – {name}', { name: c.name }), h('div', {},
    h('p', {}, t('Lege fest, welche Funktionen alle anderen in diesem Tresor nutzen dürfen. Admins (Key Vault-Administrator) dürfen immer alles. Standard: alles aus.')),
    h('div', { class: 'policy-list' }, ...POLICY_ORDER.map((f) => h('label', { class: 'inline policy-row' }, boxes[f], t(POLICY_TEXT[f])))),
    notice(t('Unabhängig davon gelten die Azure-Rollen: Wer nur „Lesen“ hat, kann auch freigeschaltete Funktionen nicht nutzen, die Schreibrechte brauchen.'), 'info'),
    state.updatedBy ? h('p', { class: 'muted small' }, t('Zuletzt geändert {date} von {user}', { date: formatDateTime(state.updated), user: state.updatedBy })) : null), [
    { label: t('Abbrechen') },
    { label: t('Speichern'), primary: true, onClick: async () => {
      await call('setPolicy', c.id, Object.fromEntries(POLICY_ORDER.map((f) => [f, boxes[f].checked])));
      toast(t('Tresor-Einstellungen gespeichert'));
      await reloadAll();
      return true;
    } },
  ]);
}

export async function exportDialog(c) {
  const progress = progressLine();
  const body = h('div', {},
    h('div', { class: 'danger-box' },
      h('h3', {}, t('⚠ Unverschlüsselter Export')),
      h('p', {}, t('Die CSV-Datei enthält alle Passwörter von „{name}“ im Klartext. Jeder, der die Datei bekommt, kann sie lesen.', { name: c.name })),
      h('ul', {},
        h('li', {}, t('Nur auf verschlüsselten Laufwerken speichern und nach Gebrauch löschen.')),
        h('li', {}, t('Nicht per E-Mail versenden und nicht in Cloud-Ordnern ablegen.')),
        h('li', {}, t('Zertifikatsdateien sind nicht enthalten, nur ihre Passwörter.')))));
  const { dialog } = modal(t('Einträge exportieren'), body, [
    { label: t('Abbrechen') },
    { label: t('Speicherort wählen und exportieren'), danger: true, onClick: async () => {
      body.append(progress.el);
      const r = await call('exportItems', c.id);
      if (!r) return false;
      toast(t('{count} Einträge exportiert: {path}', { count: r.count, path: r.filePath }));
      return true;
    } },
  ]);
  dialog.addEventListener('close', progress.stop);
}

export const licenses = new Map(); // containerId → licenseState (refreshed with the vault)

/** "Demo" badge while a vault has no license; click opens the license dialog. */
export function licenseBadge(c) {
  const slot = h('span');
  const draw = (l) => slot.replaceChildren(l && !l.licensed ? h('button', {
    type: 'button', class: 'badge warn badge-button', title: t('Ohne Lizenz: {count} von {limit} Einträgen genutzt.', { count: l.count, limit: l.limit }),
    onclick: () => licenseDialog(c),
  }, t('Demo')) : l?.expires ? h('button', {
    type: 'button', class: 'badge badge-button', title: t('Befristete Lizenz bis {date}', { date: formatDate(l.expires) }),
    onclick: () => licenseDialog(c),
  }, t('Test bis {date}', { date: formatDate(l.expires) })) : '');
  if (c.error || c.locked) return slot;
  if (licenses.has(c.id)) draw(licenses.get(c.id));
  else call('licenseState', c.id).then((l) => { licenses.set(c.id, l); draw(l); }, () => {});
  return slot;
}
