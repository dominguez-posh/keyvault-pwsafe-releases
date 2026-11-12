// Settings as a file (#478): export and import from the main menu, the OneDrive question at the first start. The main
// process reads and checks the file (desktop/settings-file.js); the window only shows the preview and asks.

import { h, modal, toast } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { st } from './state.js';
import { render } from './shell.js';

const LABELS = {
  containers: 'Tresore', hiddenContainers: 'Ausgeblendete Tresore', containerOrder: 'Reihenfolge der Tresore', defaultContainer: 'Standard-Tresor',
  tenantId: 'Tenant', clientId: 'Client-ID', autoLockMinutes: 'Automatisch sperren nach (Minuten, 0 = nie)',
  clipboardSeconds: 'Zwischenablage leeren nach (Sekunden, 0 = nie)', unlockPrompt: 'Beim Entsperren', language: 'Sprache', zoom: 'Zoom',
  transparency: 'Transparenz', theme: 'Design', sourceBadges: 'Speicherort', autoTypeKeys: 'Auto-Type-Tastenkürzel', updateMode: 'Automatische Updates',
  updateChannel: 'Update-Kanal', autoDiscover: 'Gefundene Tresore automatisch verbinden',
  signInWindows: 'Mit Windows-Konto anmelden', pimOnLock: 'PIM beim Entsperren', adminPim: 'PIM-Knopf im Admin-Modus', adminOffered: 'Admin-Modus anbieten',
};

function shown(key, value) {
  if (key === 'containers') return value.map((c) => `${c.name || c.vaultUrl.replace(/^https:\/\/|\.vault\.azure\.net\/$/g, '')} (${c.vaultUrl.replace(/^https:\/\/|\/$/g, '')})`).join(', ') || '–';
  if (Array.isArray(value)) return String(value.length);
  if (typeof value === 'boolean') return value ? t('An') : t('Aus');
  if (key === 'zoom') return `${Math.round(value * 100)} %`;
  return value === '' ? '–' : String(value);
}

const hostLabel = (id) => String(id).replace(/\.vault\.azure\.net$/, '');

/**
 * The vaults new from the file, each on its own line with name, host and tenant, to tick or not (#478 re-review). A
 * vault shown with the name of one of the user's is another vault: red and not ticked. While the vault search still
 * runs none is ticked (#511 review): one of them may be the user's own, not found yet. vaults: id → checkbox.
 */
function newVaultList(preview, vaults) {
  const list = preview.newVaults || [];
  const inFile = (preview.settings.containers || []).length;
  const rows = list.map((c) => {
    const box = h('input', { type: 'checkbox', checked: !c.clash && !preview.discovering, dataset: { vault: c.id } });
    vaults.set(c.id, box);
    return h('li', { class: c.clash ? 'clash' : null, dataset: { vault: c.id, clash: c.clash ? '1' : '0' } },
      h('label', { class: 'inline' }, box, h('b', {}, c.name || hostLabel(c.id)), ` – ${c.id} – ${t('Tenant')}: ${c.tenantId || t('Standard')}`),
      c.clash ? [' ', h('span', { class: 'badge danger' }, t('Name schon vorhanden – anderer Tresor!'))] : null);
  });
  return h('div', { class: 'settings-vaults' },
    rows.length ? [
      h('p', { class: 'small' }, h('b', {}, t('Neue Tresore aus der Datei'))),
      h('p', { class: 'small settings-vault-hint' }, t('Prüfe, dass du diese Tresore kennst.')),
      h('ul', { class: 'small' }, ...rows),
    ] : null,
    inFile > list.length ? h('p', { class: 'muted small' }, t('{n} Tresore aus der Datei hast du schon – sie bleiben, wie sie sind.', { n: inFile - list.length })) : null);
}

/**
 * The preview of an import as a list: what each setting becomes. Values that would weaken this device are greyed out
 * ("nicht übernommen (Sicherheit)"); another app registration and a new default vault have a box of their own
 * (confirm: key → checkbox); new vaults are listed one by one (vaults: id → checkbox).
 */
function previewList(preview, confirm, vaults) {
  const refused = new Set(preview.refused || []);
  const asks = new Set(preview.confirm || []);
  const fresh = new Map((preview.newVaults || []).map((c) => [c.id, c]));
  const rows = Object.entries(preview.settings).filter(([k]) => k !== 'containers').map(([k, v]) => {
    // A new default vault with name and host, so a look-alike is told apart.
    const value = k === 'defaultContainer' && fresh.has(v) ? `${fresh.get(v).name || hostLabel(v)} (${v})` : shown(k, v);
    const label = [h('b', {}, t(LABELS[k] || k)), ': ', value];
    if (refused.has(k)) return h('li', { class: 'muted', dataset: { key: k, refused: '1' } }, ...label, ' – ', t('nicht übernommen (Sicherheit)'));
    if (asks.has(k)) {
      const box = h('input', { type: 'checkbox', dataset: { confirm: k } });
      confirm.set(k, box);
      return h('li', { dataset: { key: k, ask: '1' } }, h('label', { class: 'inline' }, box, ...label));
    }
    return h('li', { dataset: { key: k } }, ...label);
  });
  return h('div', { class: 'settings-preview' },
    preview.discovering ? h('p', { class: 'small settings-discovering', dataset: { discovering: '1' } }, t('Tresorsuche läuft noch – bitte gleich erneut importieren')) : null,
    newVaultList(preview, vaults),
    rows.length || fresh.size ? h('ul', { class: 'small' }, ...rows) : h('p', { class: 'muted small' }, t('Die Datei enthält keine Einstellungen, die übernommen werden können.')),
    asks.has('tenantId') || asks.has('clientId') ? h('p', { class: 'small settings-app-hint' }, t('Andere App-Registrierung: Nur übernehmen, wenn deine IT sie vorgibt.')) : null,
    preview.dropped.length ? h('p', { class: 'muted small', dataset: { dropped: preview.dropped.join(',') } }, t('Nicht übernommen (unbekannt oder ungültig): {keys}', { keys: preview.dropped.join(', ') })) : null,
    h('p', { class: 'muted small' }, t('Tresore werden ergänzt, keiner wird entfernt. PIN, Geräteschlüssel, Anmeldungen und Lizenz stehen nie in dieser Datei.')));
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : t('unbekannt'));

/** Asks with the preview: → true when imported, false when not. */
function askImport(preview, title) {
  return new Promise((resolve) => {
    let answered = false;
    const confirm = new Map();
    const vaults = new Map();
    const ticked = (boxes) => [...boxes].filter(([, box]) => box.checked).map(([k]) => k);
    const { dialog } = modal(title, h('div', {},
      h('p', {}, t('Einstellungen von {device} ({date}) importieren?', { device: preview.device || t('unbekanntes Gerät'), date: when(preview.exportedAt) })),
      previewList(preview, confirm, vaults)), [
      { label: t('Nicht importieren'), onClick: () => { answered = true; resolve(false); } },
      { label: t('Importieren'), primary: true, onClick: async () => {
        await call('applySettingsImport', preview.token, ticked(confirm), ticked(vaults));
        answered = true;
        resolve(true);
      } },
    ]);
    dialog.classList.add('settings-import-modal');
    dialog.addEventListener('close', () => { if (!answered) resolve(false); });
  });
}

/** Main menu "Einstellungen exportieren…". */
export async function exportSettings() {
  try {
    const file = await call('exportSettings');
    if (file) toast(t('Einstellungen exportiert'));
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** Main menu "Einstellungen importieren…": file, preview, confirmation. */
export async function importSettings() {
  try {
    const preview = await call('pickSettingsImport');
    if (!preview) return;
    if (await askImport(preview, t('Einstellungen importieren'))) {
      toast(t('Einstellungen importiert'));
      await render();
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** First start without OneDrive: "Is your OneDrive folder connected?" → 'retry' or 'skip'. */
function askOneDrive() {
  return new Promise((resolve) => {
    let answered = false;
    const { dialog } = modal(t('Einstellungen übernehmen'), h('div', {},
      h('p', {}, t('Ist dein OneDrive-Ordner bereits verbunden?')),
      h('p', { class: 'muted small' }, t('Keevault legt dort eine Kopie deiner Einstellungen ab (ohne Passwörter und Schlüssel) und übernimmt sie auf einem neuen Gerät. Verbinde OneDrive und prüfe erneut, oder fahre ohne fort.'))), [
      { label: t('Ohne fortfahren'), onClick: () => { answered = true; resolve('skip'); } },
      { label: t('Erneut prüfen'), primary: true, onClick: () => { answered = true; resolve('retry'); } },
    ]);
    dialog.classList.add('settings-onedrive-modal');
    dialog.addEventListener('close', () => { if (!answered) resolve('skip'); });
  });
}

// Smoke runs show this step only when their check switches it on (desktop/smoke-settings-file.js).
const stepAllowed = () => !st.smoke || window.kvSmokeSettingsStep === true;

/**
 * First start, before the wizards: OneDrive not found → ask whether it is connected (check again / go on without);
 * settings of another device there → offer them with a preview. → true when settings were imported.
 */
export async function firstStartSettings() {
  if (!stepAllowed()) return false;
  let imported = false;
  try {
    for (let round = 0; round < 10; round++) {
      const status = await call('settingsCopyStatus');
      if (!status.oneDrive) {
        if ((await askOneDrive()) === 'retry') continue;
        break;
      }
      if (status.found) imported = await askImport(status.preview, t('Einstellungen übernehmen'));
      break;
    }
  } catch (e) {
    toast(e.message, 'error');
  }
  await call('settingsCopyDecided').catch(() => {});
  await askSettingsCopy({ firstStart: true });
  return imported;
}

// ---------------------------------------------------------------- the copy only with consent (#478 review)
let consentChecked = false; // the check from drawing the window: once per session (it looks for OneDrive)
let consentOpen = false;

/** "Keep a copy in OneDrive?" – yes / no. Closing without an answer asks again at the next start. */
function consentDialog() {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (v) => () => { answered = true; resolve(v); };
    const { dialog } = modal(t('Einstellungen im OneDrive sichern'), h('div', {},
      h('p', {}, t('Einstellungen zusätzlich als Kopie im OneDrive sichern? Darin stehen Tresornamen, -adressen und Tenant-IDs, aber keine Passwörter oder Schlüssel.')),
      h('p', { class: 'muted small' }, t('Du kannst das jederzeit unter Einstellungen → Allgemein ändern.'))), [
      { label: t('Nein'), onClick: answer(false) },
      { label: t('Ja, sichern'), primary: true, onClick: answer(true) },
    ]);
    dialog.classList.add('settings-consent-modal');
    dialog.addEventListener('close', () => { if (!answered) resolve(null); });
  });
}

/**
 * Asks once whether the settings may go to OneDrive as a copy: at the first start and on installations from before
 * the update (settingsCopy not answered yet). Nothing is written before a yes. → true when it asked.
 */
export async function askSettingsCopy({ firstStart = false } = {}) {
  if (!stepAllowed() || consentOpen || st.settings.settingsCopy === true || st.settings.settingsCopy === false) return false;
  if (!firstStart) {
    if (consentChecked) return false;
    consentChecked = true;
  }
  consentOpen = true;
  try {
    if (!(await call('settingsCopyConsentDue').catch(() => false))) return false;
    consentChecked = true;
    const on = await consentDialog();
    if (on !== null) await call('setSettingsCopy', on).catch((e) => toast(e.message, 'error'));
    return true;
  } finally {
    consentOpen = false;
  }
}

/** The Keevault folder in OneDrive is a junction or link: no copy goes there. */
export function settingsCopyBlockedNotice(folder) {
  toast(t('Die Kopie der Einstellungen wurde nicht geschrieben: {folder} ist eine Verknüpfung (Junction). Entferne sie oder schalte die Kopie in den Einstellungen aus.', { folder }), 'error');
}
