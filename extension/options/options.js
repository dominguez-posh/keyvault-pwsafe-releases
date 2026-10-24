import { h, icon, iconButton, toast, confirmDialog, modal } from '../core/dom.js';
import { importDialog } from '../core/ui-import.js';
import { setLanguage, t, LANGUAGES } from '../core/i18n.js';
import { call } from '../lib/api.js';

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

/** The extension works only together with the running desktop app – status and a way to start it. */
function desktop() {
  if (st.demo) return h('section', {}, h('h2', {}, t('Desktop-App')), h('div', { class: 'notice' }, t('Demo-Modus für Entwickler aktiv: Beispieldaten im Speicher, keine Verbindung zu Azure.')));
  const d = st.desktop;
  const badge = d.connected
    ? h('span', { class: 'badge accent' }, t('Verbunden (Version {version})', { version: d.version }))
    : h('span', { class: 'badge warn', title: d.error || '' }, d.reason === 'AppMissing' ? t('Nicht installiert') : t('Läuft nicht'));
  return h('section', {}, h('h2', {}, t('Desktop-App')),
    h('p', { class: 'hint' }, t('Die Erweiterung arbeitet ausschließlich über die Keevault-App: Anmeldung, Tresore und Schlüssel liegen dort. Läuft die App nicht, ist die Erweiterung inaktiv.')),
    h('div', { class: 'actions' }, badge,
      d.connected
        ? (st.open ? null : h('button', { class: 'btn primary', onclick: () => call('unlock').catch((e) => toast(e.message, 'error')) }, icon('unlock'), t('In der Desktop-App entsperren')))
        : d.reason === 'AppMissing'
          ? h('a', { class: 'btn primary', href: 'https://keevault.de/download.html', target: '_blank', rel: 'noopener' }, t('Keevault herunterladen'))
          : h('button', { class: 'btn primary', onclick: () => call('unlock').catch((e) => toast(e.message, 'error')) }, icon('unlock'), t('Keevault starten'))));
}

function containers() {
  const accessBadge = (c) => {
    if (c.error) return h('span', { class: 'badge danger', title: c.error.message }, c.error.status === 403 ? t('Kein Zugriff') : t('Fehler'));
    if (c.locked) return h('span', { class: 'badge warn' }, t('Gesperrt'));
    if (!c.access) return null;
    if (c.access.manage && c.access.write) return h('span', { class: 'badge accent' }, t('Verwalten'));
    if (c.access.write) return h('span', { class: 'badge accent' }, t('Bearbeiten'));
    if (c.access.read) return h('span', { class: 'badge' }, t('Lesen'));
    return h('span', { class: 'badge warn' }, t('Kein Datenzugriff'));
  };
  const rows = st.containers.map((c) => h('div', { class: 'container-row' },
    icon(c.source === 'file' ? 'note' : c.protected ? 'shield' : 'vault', 20),
    h('div', { class: 'row-text' },
      h('div', { class: 'row-title' }, c.name, accessBadge(c)),
      h('div', { class: 'row-sub' }, c.count != null ? t('{count} Einträge', { count: c.count }) : ''))));
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
    h('p', { class: 'hint' }, t('Die Tresore der Desktop-App. Neue Tresore, Freigaben und Schutz verwaltest du in der App.')),
    st.open ? (rows.length ? rows : h('p', { class: 'muted' }, t('Noch keine Tresore gefunden.'))) : h('p', { class: 'muted' }, t('Nach dem Entsperren in der App werden die Tresore angezeigt.')),
    h('div', { class: 'actions' }, importButton));
}

function behaviour() {
  const s = st.settings;
  const toggle = (key, label, hint) => h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked: !!s[key], disabled: enforced(key), onchange: (e) => patch({ [key]: e.target.checked }) }),
    h('div', {}, h('div', {}, label, ' ', policyNote(key)), hint ? h('div', { class: 'muted small' }, hint) : null));
  const number = (key, label, hint) => h('div', { class: 'field' }, h('label', {}, label, ' ', policyNote(key)),
    h('input', { type: 'number', min: 0, max: 1440, value: s[key], disabled: enforced(key), onchange: (e) => patch({ [key]: Number(e.target.value) || 0 }) }),
    hint ? h('div', { class: 'muted small' }, hint) : null);
  return h('section', {},
    h('h2', {}, t('Verhalten')),
    toggle('passkeys', t('Passkeys in Keevault speichern und verwenden'), t('Ersetzt beim Anlegen und Anmelden den Passkey-Dialog des Browsers. „Anderes Gerät verwenden“ öffnet weiterhin Windows Hello oder Sicherheitsschlüssel.')),
    toggle('inlineMenu', t('Auswahlmenü in Anmeldefeldern anzeigen')),
    toggle('savePrompt', t('Anbieten, neue oder geänderte Logins zu speichern')),
    toggle('copyTotpOnFill', t('Einmalcode nach dem Ausfüllen in die Zwischenablage kopieren')),
    number('clipboardSeconds', t('Zwischenablage leeren nach (Sekunden)'), t('0 = nie, mindestens 30')));
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
  content.replaceChildren(h('div', { class: 'page' }, general(), desktop(), containers(), behaviour(), neverSave()));
  document.body.dataset.ready = '1';
}

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'state:changed' && !document.querySelector('dialog[open]')) render();
  for (const fn of progressListeners) fn(m);
});

render().catch((e) => content.replaceChildren(h('div', { class: 'notice error' }, e.message)));
