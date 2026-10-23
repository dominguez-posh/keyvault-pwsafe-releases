import { h, icon, iconButton, toast, confirmDialog, modal } from '../core/dom.js';
import { manageDialog, enableDialog, unlockPanel } from '../core/ui-protect.js';
import { importDialog } from '../core/ui-import.js';
import { setLanguage, t, LANGUAGES } from '../core/i18n.js';
import { call } from '../lib/api.js';
import { protectCtx } from '../lib/protect-ctx.js';

const content = document.getElementById('content');
const progressListeners = new Set();
let st;

const enforced = (key) => st.settings.enforced.includes(key);
const policyNote = (key) => (enforced(key) ? h('span', { class: 'badge accent', title: t('Vom Administrator per Richtlinie festgelegt') }, t('Richtlinie')) : null);

async function patch(values) {
  try {
    await call('updateSettings', { patch: values });
    toast(t('Gespeichert'));
    await render();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function general() {
  const language = h('select', { disabled: enforced('language'), onchange: (e) => patch({ language: e.target.value }) },
    ...Object.entries(LANGUAGES).map(([k, label]) => h('option', { value: k, selected: st.settings.language === k }, k === 'auto' ? t(label) : label)));
  return h('section', {}, h('h2', {}, t('Allgemein')),
    h('div', { class: 'field' }, h('label', {}, t('Sprache'), ' ', policyNote('language')), language));
}

function connection() {
  const tenant = h('input', { value: st.settings.tenantId, placeholder: t('00000000-0000-0000-0000-000000000000 oder contoso.onmicrosoft.com'), disabled: enforced('tenantId') });
  const client = h('input', { value: st.settings.clientId, placeholder: t('Anwendungs-ID (Client-ID) der App-Registrierung'), disabled: enforced('clientId') });
  const redirect = h('input', { value: st.redirectUri, readOnly: true });
  return h('section', {},
    h('h2', {}, t('Microsoft Entra ID (Key-Vault-Tresore)')),
    st.demo ? h('div', { class: 'notice' }, t('Demo-Modus für Entwickler aktiv: Beispieldaten im Speicher, keine Verbindung zu Azure.')) : null,
    h('div', { class: 'field' }, h('label', {}, t('Tenant-ID'), ' ', policyNote('tenantId')), tenant),
    h('div', { class: 'field' }, h('label', {}, t('Client-ID'), ' ', policyNote('clientId')), client),
    h('div', { class: 'field' }, h('label', {}, t('Redirect-URI (in der App-Registrierung als „Single-Page-Anwendung“ eintragen)')),
      h('div', { class: 'field-row' }, redirect, iconButton('copy', t('Kopieren'), () => navigator.clipboard.writeText(st.redirectUri).then(() => toast(t('Kopiert')))))),
    h('p', { class: 'hint' }, t('Erweiterungs-ID: {id}. Das Skript infra/Setup-KvPwSafe.ps1 legt die App-Registrierung passend an.', { id: st.extensionId })),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', disabled: enforced('tenantId') && enforced('clientId'), onclick: () => patch({ tenantId: tenant.value.trim(), clientId: client.value.trim() }) }, t('Speichern')),
      st.unlocked
        ? h('span', { class: 'muted' }, t('Angemeldet als {user}', { user: st.account.username }))
        : st.configured ? h('button', { class: 'btn', onclick: () => call('unlock').then(render, (e) => toast(e.message, 'error')) }, icon('unlock'), t('Jetzt anmelden')) : null));
}

function desktop() {
  const statusEl = h('span', { class: 'muted' }, h('span', { class: 'spinner' }));
  if (st.settings.desktopBridge) {
    call('desktopStatus').then((s) => statusEl.replaceChildren(s.connected
      ? h('span', { class: 'badge accent' }, t('Verbunden (Version {version})', { version: s.version }))
      : h('span', { class: 'badge warn', title: s.error }, t('Nicht verbunden'))));
  } else statusEl.replaceChildren();
  return h('section', {}, h('h2', {}, t('Desktop-App')),
    h('label', { class: 'switch' },
      h('input', { type: 'checkbox', checked: st.settings.desktopBridge, disabled: enforced('desktopBridge'), onchange: (e) => patch({ desktopBridge: e.target.checked }) }),
      h('div', {}, h('div', {}, t('Tresore und Anmeldung der Desktop-App verwenden'), ' ', statusEl),
        h('div', { class: 'muted small' }, t('Empfohlen: Die Erweiterung nutzt Anmeldung, Key Vaults und Datei-Tresore der Desktop-App – hier muss dann nichts eingetragen werden. Entsperrt wird in der Desktop-App.')))));
}

function containers() {
  const input = h('input', { placeholder: t('https://<name>.vault.azure.net oder Einladungslink') });
  const name = h('input', { placeholder: t('Anzeigename (optional)') });
  const sourceLabel = { policy: t('Richtlinie'), manual: t('Manuell'), discovered: t('Gefunden'), file: t('Desktop-App') };
  const ctx = protectCtx(st.account);
  const accessBadge = (c) => {
    if (c.error) return h('span', { class: 'badge danger', title: c.error.message }, c.error.status === 403 ? t('Kein Zugriff') : t('Fehler'));
    if (c.locked) return h('span', { class: 'badge warn' }, t('Gesperrt'));
    if (!c.access) return c.count != null ? h('span', { class: 'badge' }, t('Zugriff')) : null;
    if (c.access.manage && c.access.write) return h('span', { class: 'badge accent' }, t('Verwalten'));
    if (c.access.write) return h('span', { class: 'badge accent' }, t('Bearbeiten'));
    if (c.access.read) return h('span', { class: 'badge' }, t('Lesen'));
    return h('span', { class: 'badge warn' }, t('Kein Datenzugriff'));
  };
  const protection = (c) => {
    if (c.kind === 'remote' || c.error) return null;
    if (!c.protected) {
      return h('button', { class: 'btn small', disabled: c.access?.write === false, onclick: () => enableDialog(c, ctx, render) }, icon('shield', 14), t('Zusätzlich schützen'));
    }
    if (c.locked) {
      return h('button', { class: 'btn small', onclick: async () => {
        const info = await call('protection:info', { containerId: c.id });
        const { close } = modal(t('Entsperren'), unlockPanel(c, info, ctx, () => { close(); render(); }), []);
      } }, icon('unlock', 14), t('Entsperren'));
    }
    return h('button', { class: 'btn small', onclick: () => manageDialog(c, ctx, render) }, icon('shield', 14), t('Schutz und Benutzer'));
  };
  const rows = st.containers.map((c) => h('div', { class: 'container-row' },
    icon(c.kind === 'remote' ? 'note' : c.protected ? 'shield' : 'vault', 20),
    h('div', { class: 'row-text' },
      h('div', { class: 'row-title' }, c.name, accessBadge(c)),
      h('div', { class: 'row-sub' }, `${c.vaultUrl || c.path || ''} · ${(c.sources || []).map((s) => sourceLabel[s] || s).join(', ')}${c.count != null ? ` · ${t('{count} Einträge', { count: c.count })}` : ''}`)),
    protection(c),
    c.kind === 'remote' || (c.sources || []).includes('policy') ? null : iconButton('trash', (c.sources || []).includes('manual') ? t('Entfernen') : t('Ausblenden'), async () => {
      if (!(await confirmDialog(t('Tresor ausblenden'), t('„{name}“ aus der Liste entfernen? Die Daten im Key Vault bleiben unverändert.', { name: c.name }), { confirmLabel: t('Entfernen') }))) return;
      st = await call('removeContainer', { id: c.id });
      render();
    })));
  const importButton = h('button', { class: 'btn', disabled: !st.open, onclick: () => importDialog({
    containers: st.containers.filter((c) => c.access?.write !== false && !c.error && !c.locked).map((c) => ({ id: c.id, name: c.name })),
    defaultContainer: st.settings.defaultContainer,
    existing: async (containerId) => (await call('items')).filter((i) => i.containerId === containerId),
    save: async (containerId, items, onProgress) => {
      const listener = (m) => {
        if (m?.type === 'import:progress') onProgress(m.done, m.total);
      };
      chrome.runtime.onMessage.addListener(listener);
      try {
        return await call('import', { containerId, items });
      } finally {
        chrome.runtime.onMessage.removeListener(listener);
      }
    },
    download: (filename, text) => {
      const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: filename });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    },
    onDone: render,
  }) }, icon('upload'), t('Importieren …'));
  importButton.dataset.action = 'import';
  return h('section', {},
    h('h2', {}, t('Tresore')),
    h('p', { class: 'hint' }, t('Jeder Tresor ist ein Azure Key Vault oder eine Datei der Desktop-App. Key Vaults mit dem Tag kvpwsafe=container werden nach der Anmeldung automatisch gefunden. Freigaben und neue Tresore verwaltest du in der Desktop-App.')),
    st.open ? (rows.length ? rows : h('p', { class: 'muted' }, t('Noch keine Tresore gefunden.'))) : h('p', { class: 'muted' }, t('Nach dem Entsperren werden die Tresore angezeigt.')),
    h('div', { class: 'grid2', style: { marginTop: '12px' } }, input, name),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          st = await call('addContainer', { input: input.value, name: name.value.trim() });
          toast(t('Tresor hinzugefügt'));
          render();
        } catch (e) {
          toast(e.message, 'error');
        }
      } }, icon('plus'), t('Hinzufügen')),
      st.open ? h('button', { class: 'btn', onclick: async () => {
        try {
          const r = await call('refresh');
          if (r.discoverError) toast(t('Suche: {message}', { message: r.discoverError }), 'error');
          await render();
        } catch (e) {
          toast(e.message, 'error');
        }
      } }, icon('refresh'), t('Neu suchen')) : null,
      importButton));
}

function behaviour() {
  const s = st.settings;
  const toggle = (key, label, hint) => h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked: !!s[key], disabled: enforced(key), onchange: (e) => patch({ [key]: e.target.checked }) }),
    h('div', {}, h('div', {}, label, ' ', policyNote(key)), hint ? h('div', { class: 'muted small' }, hint) : null));
  const number = (key, label, hint) => h('div', { class: 'field' }, h('label', {}, label, ' ', policyNote(key)),
    h('input', { type: 'number', min: 0, max: 1440, value: s[key], disabled: enforced(key), onchange: (e) => patch({ [key]: Number(e.target.value) || 0 }) }),
    hint ? h('div', { class: 'muted small' }, hint) : null);
  const unlockPrompt = h('select', { disabled: enforced('unlockPrompt'), onchange: (e) => patch({ unlockPrompt: e.target.value }) },
    ...[['select_account', 'Konto bestätigen (Standard)'], ['login', 'Immer neu anmelden (Passwort/MFA)'], ['none', 'Einmaliges Anmelden (SSO) ohne Rückfrage']]
      .map(([v, l]) => h('option', { value: v, selected: s.unlockPrompt === v }, t(l))));
  return h('section', {},
    h('h2', {}, t('Verhalten')),
    toggle('passkeys', t('Passkeys in Keevault speichern und verwenden'), t('Ersetzt beim Anlegen und Anmelden den Passkey-Dialog des Browsers. „Anderes Gerät verwenden“ öffnet weiterhin Windows Hello oder Sicherheitsschlüssel.')),
    toggle('inlineMenu', t('Auswahlmenü in Anmeldefeldern anzeigen')),
    toggle('savePrompt', t('Anbieten, neue oder geänderte Logins zu speichern')),
    toggle('copyTotpOnFill', t('Einmalcode nach dem Ausfüllen in die Zwischenablage kopieren')),
    h('div', { class: 'grid2' },
      number('autoLockMinutes', t('Automatisch sperren nach (Minuten Inaktivität)'), t('0 = nur beim Sperren des Computers')),
      number('clipboardSeconds', t('Zwischenablage leeren nach (Sekunden)'), t('0 = nie, mindestens 30'))),
    h('div', { class: 'field' }, h('label', {}, t('Entsperren'), ' ', policyNote('unlockPrompt')), unlockPrompt));
}

function neverSave() {
  const list = st.settings.neverSave;
  return h('section', {},
    h('h2', {}, t('Nie speichern für')),
    list.length
      ? h('div', { class: 'chips' }, ...list.map((hostName) => h('span', { class: 'badge' }, hostName,
        iconButton('x', t('Entfernen'), () => patch({ neverSave: list.filter((x) => x !== hostName) }), { size: 12 }))))
      : h('p', { class: 'muted' }, t('Keine Ausnahmen.')));
}

async function render() {
  st = await call('state');
  setLanguage(st.settings.language);
  document.title = `Keevault – ${t('Einstellungen')}`;
  document.getElementById('version').textContent = t('Version {version}', { version: st.version });
  content.replaceChildren(h('div', { class: 'page' }, general(), connection(), desktop(), containers(), behaviour(), neverSave()));
  document.body.dataset.ready = '1';
}

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'state:changed' && !document.querySelector('dialog[open]')) render();
  for (const fn of progressListeners) fn(m);
});

render().catch((e) => content.replaceChildren(h('div', { class: 'notice error' }, e.message)));
