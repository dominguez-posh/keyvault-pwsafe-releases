// Before the vaults are open: first setup and the locked screen.

import { h, icon, toast, formatDateTime } from '../../../extension/core/dom.js';
import { t, LANGUAGES } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { root } from './layout.js';
import { st, ui } from './state.js';
import { field, notice, openUrl } from './helpers.js';
import { ADMIN_LINKS } from './admin-tools.js';
import { createFileDialog } from './file-vaults.js';
import { checkWindowsRequests } from './requests.js';
import { settingsDialog } from './settings.js';
import { render } from './shell.js';

function languageSelect() {
  return h('select', { class: 'lang-select', title: t('Sprache'), onchange: async (e) => {
    await call('updateSettings', { language: e.target.value });
    render();
  } }, ...Object.entries(LANGUAGES).map(([k, label]) => h('option', { value: k, selected: st.settings.language === k }, k === 'auto' ? t(label) : label)));
}

function splash(...children) {
  root.replaceChildren(h('div', { class: 'splash' }, h('div', { class: 'card' },
    h('div', { class: 'card-top' }, h('img', { src: '../assets/icon.png', class: 'splash-logo', alt: '' }), languageSelect()), ...children)));
}

export function renderSetup(error) {
  const entraCard = h('button', { class: 'option-card', onclick: async () => {
    entraCard.disabled = true;
    entraCard.querySelector('.muted').replaceChildren(h('span', { class: 'spinner' }), st.signInMode === 'windows' ? t('Anmeldung mit deinem Windows-Konto …') : t('Anmeldung im Browser …'));
    try {
      const r = await call('unlock', { entra: true });
      if (r.discoverError) toast(t('Tresor-Suche: {message}', { message: r.discoverError }), 'error');
      await render();
    } catch (e) {
      renderSetup(e.message);
    }
  } }, icon('vault', 22), h('div', {},
    h('b', {}, t('Azure Key Vault (Microsoft Entra ID)')),
    h('div', { class: 'muted small' }, t('Für Unternehmen: Anmeldung mit dem Arbeitskonto, Teilen über Azure-Rollen, Audit-Log.'))));
  splash(
    h('h1', {}, t('Keevault einrichten')),
    h('p', { class: 'muted' }, t('Wo sollen deine Passwörter und Passkeys liegen?')),
    error ? notice(error) : null,
    entraCard,
    h('button', { class: 'option-card', onclick: createFileDialog }, icon('note', 22), h('div', {},
      h('b', {}, t('Lokale Datei (wie KeePass)')),
      h('div', { class: 'muted small' }, t('Verschlüsselte Datei, abgesichert mit Passkey und/oder Masterpasswort – auch auf einem Netzlaufwerk für mehrere Benutzer.')))),
    h('button', { class: 'linklike', onclick: openFile }, t('Vorhandene Datei öffnen …')),
  );
}

export async function openFile() {
  try {
    const id = await call('openFile');
    if (!id) return;
    if (!st.opened) await call('unlock', { entra: false });
    ui.containerId = id;
    ui.view = 'container';
    await render();
  } catch (e) {
    toast(e.message, 'error');
  }
}

export function renderLocked(error) {
  const entra = h('button', { class: 'btn primary block', onclick: () => open(true, entra) }, icon('unlock'), t('Mit Microsoft Entra ID entsperren'));
  const local = h('button', { class: 'btn block', onclick: () => open(false, local) }, icon('note'), t('Nur Datei-Tresore öffnen'));
  const pin = st.pinSet ? h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: t('PIN'), class: 'pin-input', onkeydown: (e) => {
    if (e.key === 'Enter') open(true, entra);
  } }) : null;
  async function open(withEntra, button) {
    button.disabled = true;
    button.replaceChildren(h('span', { class: 'spinner' }), withEntra ? (st.signInMode === 'windows' ? t('Anmeldung mit deinem Windows-Konto …') : t('Anmeldung im Browser …')) : t('Öffnen …'));
    try {
      if (pin) await call('verifyPin', pin.value);
      const r = await call('unlock', { entra: withEntra });
      if (r.discoverError) toast(t('Tresor-Suche: {message}', { message: r.discoverError }), 'error');
      if (r.offline) toast(t('Kein Netzwerk – Offline-Stand vom {date}, nur lesen', { date: formatDateTime(r.offlineAt) }), 'warn');
      const firstLockedFile = r.containers.find((c) => c.kind === 'file' && c.locked);
      if (!withEntra && firstLockedFile) {
        ui.containerId = firstLockedFile.id;
        ui.view = 'container';
      }
      await render();
    } catch (e) {
      renderLocked(e.message);
    }
  }
  splash(
    h('h1', {}, t('Tresor gesperrt')),
    h('p', { class: 'muted' }, st.signInMode === 'windows'
      ? t('Anmeldung mit deinem Windows-Konto (Single Sign-on) – falls nötig erscheint der Microsoft-Anmeldedialog.')
      : t('Melde dich mit deinem Arbeitskonto an. Die Anmeldung öffnet sich im Standardbrowser.')),
    error ? notice(error) : null,
    h('div', { id: 'windows-waiting', class: 'notice info', hidden: true }, t('Windows wartet auf einen Passkey – entsperre Keevault, um fortzufahren.')),
    pin ? field(t('PIN'), pin) : null,
    st.pinSet ? null : h('p', { class: 'muted small' }, t('Tipp: Mit einer PIN (unter Einstellungen) entsperrst du ohne neues Microsoft-Fenster – deine Tresore erscheinen sofort.')),
    entra,
    st.hasFiles ? local : null,
    // PIM before signing in (e.g. the Key Vault role is only eligible): turned on in the menu → View.
    st.settings.pimOnLock ? h('button', { class: 'btn block pim-lock', title: t('Rolle mit Privileged Identity Management aktivieren'), onclick: () => openUrl(ADMIN_LINKS[0].url) },
      icon('ac-elevate'), t('PIM: Rolle aktivieren')) : null,
    h('div', { class: 'card-links' },
      h('button', { class: 'linklike', onclick: settingsDialog }, t('Einstellungen')),
      h('button', { class: 'linklike', onclick: async () => {
        await call('signOut');
        toast(t('Abgemeldet – beim nächsten Entsperren Konto wählen'));
      } }, t('Anderes Konto'))),
  );
  setTimeout(() => (pin || entra).focus(), 0);
  checkWindowsRequests();
}
