// Import wizard shared by the extension options page and the desktop app.
// ctx: { containers: [{ id, name }] (writable, unlocked), defaultContainer, existing(containerId) → summaries,
//        save(containerId, items, onProgress(done, total)) → { imported, errors }, download(filename, text),
//        openKdbx(bytes, { password, keyFile }) → KeePass XML (desktop app only: decrypts a .kdbx database) }

import { h, icon, modal, toast, setChildren } from './dom.js';
import { parseImport, applyCsvMapping, CSV_TARGETS, CSV_TARGET_LABELS, duplicateKey } from './importer.js';
import { SAMPLE_CSV } from './import-sample.js';
import { MAX_FOLDER_DEPTH, folderDepth } from './model.js';
import { isImageDataUrl, ICON_MAX_CHARS } from './image.js';
import { normalizeFolderIcon, isFolderImage, MAX_FOLDER_IMAGE } from './folder-icons.js';
import { t } from './i18n.js';

const FORMATS = [
  'Bitwarden: JSON (unverschlüsselt, inkl. Passkeys) oder CSV',
  '1Password: 1PUX oder CSV',
  'KeePass / KeePassXC: Datenbank (.kdbx, mit Master-Passwort und/oder Schlüsseldatei), XML oder CSV (inkl. KeePassXC-Passkeys)',
  'Edge, Chrome, Firefox: CSV',
  'Allgemein: CSV mit frei zuordenbaren Spalten',
];

// Browsers keep their saved passwords encrypted with a key bound to the Windows/macOS account, not with a password
// the user could type – so there is nothing to enter and no way to read the file directly. The one safe route that
// works for every browser is its own CSV export; Keevault only shows the exact clicks, then reads the file here.
// adr: path to the browser's own password page; it opens only from inside the browser, so it stays as text to copy.
const BROWSER_GUIDES = [
  { id: 'chrome', name: 'Chrome', adr: 'chrome://password-manager/passwords', steps: [
    'Menü ⋮ oben rechts → „Passwörter und automatisches Ausfüllen“ → „Google Passwortmanager“.',
    'Links „Einstellungen“ → bei „Passwörter exportieren“ auf „Herunterladen“.',
    'Mit dem Windows-Login bestätigen – es entsteht eine CSV-Datei.',
  ] },
  { id: 'edge', name: 'Edge', adr: 'edge://wallet/passwords', steps: [
    'Menü ⋯ oben rechts → „Einstellungen“ → „Profile“ → „Passwörter“.',
    'Rechts bei „Gespeicherte Passwörter“ auf ⋯ → „Passwörter exportieren“.',
    'Mit dem Windows-Login bestätigen – es entsteht eine CSV-Datei.',
  ] },
  { id: 'firefox', name: 'Firefox', adr: 'about:logins', steps: [
    'Menü ☰ oben rechts → „Passwörter“.',
    'Oben rechts ⋯ → „Zugangsdaten exportieren…“ → bestätigen.',
    'Gibt es ein Hauptpasswort, einmal eingeben – es entsteht eine CSV-Datei.',
  ] },
];

/** KeePass database signatures (0x9AA2D903, 0xB54BFB67, little endian). */
const isKdbxBytes = (b) => b.length > 12 && b[0] === 0x03 && b[1] === 0xd9 && b[2] === 0xa2 && b[3] === 0x9a && b[4] === 0x67 && b[5] === 0xfb && b[6] === 0x4b && b[7] === 0xb5;

/** A KeePass image (data URL) made small enough for an entry or folder icon; '' when it cannot be read. */
async function smallImage(dataUrl, size, maxChars) {
  if (isImageDataUrl(dataUrl, maxChars)) return dataUrl;
  try {
    // Drawn from the data URL itself (the pages allow data: images, not blob: ones), only raster images.
    if (!/^data:image\/(png|jpeg|gif|webp|bmp|x-icon);base64,/.test(dataUrl)) return '';
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
    for (let s = size; s >= 16; s = Math.round(s * 0.75)) {
      const scale = Math.min(s / (img.naturalWidth || s), s / (img.naturalHeight || s), 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round((img.naturalWidth || s) * scale));
      canvas.height = Math.max(1, Math.round((img.naturalHeight || s) * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const url of [canvas.toDataURL('image/png'), canvas.toDataURL('image/webp', 0.85)]) if (isImageDataUrl(url, maxChars)) return url;
    }
  } catch {
    // Unreadable image: no icon.
  }
  return '';
}

/** The one top folder all entries share ("PWDS"), when leaving it out keeps a deeper source within three levels. */
export function commonTopFolder(items, folders = []) {
  const paths = [...items.map((i) => i.folder || ''), ...folders];
  const top = paths[0]?.split('/')[0];
  if (!top || !paths.every((p) => p === top || p.startsWith(`${top}/`))) return '';
  return paths.some((p) => folderDepth(p) > MAX_FOLDER_DEPTH) ? top : '';
}

const withoutTop = (path, top) => (path === top ? '' : path.startsWith(`${top}/`) ? path.slice(top.length + 1) : path);

export function downloadSample(ctx) {
  ctx.download('kvpwsafe-import-sample.csv', SAMPLE_CSV);
}

export function importDialog(ctx) {
  if (!ctx.containers.length) {
    toast(t('Kein entsperrter Tresor mit Schreibrechten verfügbar'), 'error');
    return;
  }
  const body = h('div', {});
  const fileInput = h('input', { type: 'file', accept: '.csv,.json,.xml,.1pux,.txt,.zip,.kdbx' });
  let parsed = null;
  let mapping = null;
  let items = [];
  const importButton = h('button', { type: 'button', class: 'btn primary', disabled: true }, icon('upload'), t('Importieren'));
  const container = h('select', {}, ...ctx.containers.map((c) => h('option', { value: c.id, selected: c.id === ctx.defaultContainer }, c.name)));
  const skipDuplicates = h('input', { type: 'checkbox', checked: true });
  const progress = h('progress', { max: 1, value: 0, hidden: true });
  const summary = h('div', {});
  const preview = h('div', { class: 'import-preview' });
  const mappingBox = h('div', {});
  const kdbxBox = h('div', {});
  // #327: KeePass databases are often one top group deep more than the app's three levels – offer to leave it out.
  const dropTop = h('input', { type: 'checkbox', checked: true });
  const topBox = h('div', {});
  // #326: which file may be deleted – only an unencrypted export, never the KeePass database or its key file.
  const hint = h('p', { class: 'muted small import-hint' });
  const setHint = (kdbx) => { hint.textContent = kdbx
    ? t('Keevault liest die KeePass-Datei und die Schlüsseldatei nur – beide bleiben unverändert, es wird nichts gelöscht.')
    : t('Keevault löscht keine Dateien. Eine unverschlüsselte Exportdatei (CSV, JSON, XML) nach dem Import bitte selbst sicher löschen – KeePass-Datenbanken (.kdbx) und Schlüsseldateien nicht.'); };
  setHint(false);

  const renderPreview = () => {
    items = parsed.csv ? applyCsvMapping(parsed.csv.columns, parsed.csv.rows, mapping) : parsed.items;
    const passkeys = items.reduce((n, i) => n + i.passkeys.length, 0);
    const notes = items.filter((i) => i.type === 'note').length;
    setChildren(summary, h('p', {}, h('b', {}, parsed.label), ' · ',
      t('{count} Einträge', { count: items.length }),
      passkeys ? ` · ${t('{count} Passkeys', { count: passkeys })}` : '',
      notes ? ` · ${t('{count} Notizen', { count: notes })}` : ''));
    const top = commonTopFolder(items, parsed.folders);
    setChildren(topBox, top ? h('label', { class: 'inline small top-folder' }, dropTop,
      t('Obersten Ordner „{name}“ weglassen – so bleibt die Ordnerstruktur innerhalb von {max} Ebenen erhalten.', { name: top, max: MAX_FOLDER_DEPTH })) : null);
    const folderOf = (f) => (top && dropTop.checked ? withoutTop(f || '', top) : f);
    setChildren(preview, items.slice(0, 8).map((i) => h('div', { class: 'row-sub' }, `${i.title}${i.username ? ` – ${i.username}` : ''}${folderOf(i.folder) ? ` (${folderOf(i.folder)})` : ''}`)),
      items.length > 8 ? h('div', { class: 'row-sub' }, t('… und {count} weitere', { count: items.length - 8 })) : null);
    importButton.disabled = !items.length;
  };
  dropTop.addEventListener('change', () => renderPreview());

  const renderMapping = () => {
    if (!parsed.csv) {
      setChildren(mappingBox);
      return;
    }
    const { columns, rows } = parsed.csv;
    setChildren(mappingBox, h('h3', {}, t('Spalten zuordnen')),
      h('div', { class: 'mapping' }, ...columns.map((col, i) => h('div', { class: 'mapping-row' },
        h('div', {}, h('b', {}, col || t('Spalte {n}', { n: i + 1 })), h('div', { class: 'row-sub' }, (rows.find((r) => r[i]) || [])[i]?.slice(0, 40) || '–')),
        h('select', { onchange: (e) => { mapping[i] = e.target.value; renderPreview(); } },
          ...[...CSV_TARGETS, ...(mapping[i] === 'bwfields' ? ['bwfields'] : [])].map((target) => h('option', { value: target, selected: mapping[i] === target },
            target === 'bwfields' ? t('Zusatzfelder (Bitwarden)') : t(CSV_TARGET_LABELS[target]))))))));
  };

  const showError = (e) => {
    parsed = null;
    importButton.disabled = true;
    setChildren(summary, h('div', { class: 'notice error' }, e.message));
    setChildren(preview);
    setChildren(mappingBox);
    setChildren(topBox);
  };

  // KeePass database: master password and/or key file, then decrypted by the app and read like KeePass XML.
  const askKdbx = (bytes) => {
    if (!ctx.openKdbx) throw new Error(t('KeePass-Datenbanken (.kdbx) lassen sich in der Desktop-App importieren'));
    const password = h('input', { type: 'password', autocomplete: 'off', class: 'kdbx-password' });
    const keyFile = h('input', { type: 'file', class: 'kdbx-keyfile' });
    const open = h('button', { type: 'button', class: 'btn primary small kdbx-open' }, icon('key', 14), t('Öffnen'));
    const status = h('div', {});
    const run = async () => {
      open.disabled = true;
      setChildren(status, h('div', { class: 'muted small' }, t('Wird entschlüsselt …')));
      try {
        const kf = keyFile.files?.[0] ? new Uint8Array(await keyFile.files[0].arrayBuffer()) : null;
        const xml = await ctx.openKdbx(bytes, { password: password.value, keyFile: kf });
        parsed = { ...(await parseImport({ name: 'keepass.xml', text: xml })), label: 'KeePass (KDBX)' };
        mapping = null;
        setChildren(kdbxBox);
        renderMapping();
        renderPreview();
      } catch (e) {
        setChildren(status, h('div', { class: 'notice error' }, e.message));
        open.disabled = false;
      }
    };
    open.addEventListener('click', run);
    password.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    setChildren(kdbxBox, h('h3', {}, t('KeePass-Datenbank öffnen')),
      h('p', { class: 'muted small' }, t('Wie in KeePass: Master-Passwort, Schlüsseldatei oder beides.')),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', {}, t('Master-Passwort')), password),
        h('div', { class: 'field' }, h('label', {}, t('Schlüsseldatei (optional)')), keyFile)),
      h('div', { class: 'field-row' }, open), status);
    password.focus();
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    setChildren(kdbxBox);
    setChildren(topBox);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setHint(isKdbxBytes(bytes));
      if (isKdbxBytes(bytes)) {
        parsed = null;
        importButton.disabled = true;
        setChildren(summary);
        setChildren(preview);
        setChildren(mappingBox);
        askKdbx(bytes);
        return;
      }
      parsed = await parseImport({ name: file.name, bytes });
      mapping = parsed.csv ? [...parsed.csv.mapping] : null;
      renderMapping();
      renderPreview();
    } catch (e) {
      showError(e);
    }
  });

  importButton.addEventListener('click', async () => {
    importButton.disabled = true;
    try {
      // Leaving out the shared top folder (#327) – entries, empty folders and folder symbols alike.
      const top = commonTopFolder(items, parsed.folders);
      const folderOf = (f) => (top && dropTop.checked ? withoutTop(f || '', top) : f || '');
      // KeePass images (#327): entry icons and folder symbols made small enough, standard symbols as they are.
      const shrunk = new Map();
      const small = (src, size, max) => {
        const k = `${size}:${src}`;
        if (!shrunk.has(k)) shrunk.set(k, smallImage(src, size, max));
        return shrunk.get(k);
      };
      let list = await Promise.all(items.map(async ({ customIcon, ...i }) => ({
        ...i, folder: folderOf(i.folder), icon: i.icon || (customIcon ? await small(customIcon, 64, ICON_MAX_CHARS) : ''),
      })));
      const folderIcons = {};
      for (const [p, v] of Object.entries(parsed.folderIcons || {})) {
        const path = folderOf(p);
        const icon = normalizeFolderIcon(isFolderImage(v) ? await small(v, 32, MAX_FOLDER_IMAGE) : v);
        if (path && icon) folderIcons[path] = icon;
      }
      const folders = (parsed.folders || []).map(folderOf).filter(Boolean);
      let skipped = 0;
      if (skipDuplicates.checked) {
        const existing = new Set((await ctx.existing(container.value)).map(duplicateKey));
        list = list.filter((i) => !existing.has(duplicateKey(i)));
        skipped = items.length - list.length;
      }
      progress.hidden = false;
      progress.max = Math.max(1, list.length);
      // Folder symbols and empty folders of the source go along (KeePass groups); only the desktop app stores them.
      const r = await ctx.save(container.value, list, (done) => { progress.value = done; }, { folderIcons, folders });
      toast(t('{imported} von {total} Einträgen importiert', { imported: r.imported, total: items.length }) + (skipped ? ` · ${t('{count} Duplikate übersprungen', { count: skipped })}` : ''));
      close();
      if (r.errors?.length) modal(t('Nicht importiert'), h('pre', { class: 'errors' }, r.errors.join('\n')));
      ctx.onDone?.();
    } catch (e) {
      toast(e.message, 'error');
      importButton.disabled = false;
    }
  });

  // Guide for Chrome/Edge/Firefox: the browser's own CSV export (no password to type – the browser's key is bound to
  // the OS account), shown as exact clicks; the resulting file is then chosen below like any CSV.
  const browserSteps = h('div', { class: 'browser-steps', hidden: true });
  const showGuide = (g) => {
    setChildren(browserSteps,
      h('ol', { class: 'small' }, ...g.steps.map((s) => h('li', {}, t(s)))),
      h('p', { class: 'muted small' }, t('Seite im Browser direkt:'), ' ', h('code', {}, g.adr)),
      h('p', { class: 'muted small' }, t('Danach unten die heruntergeladene CSV-Datei auswählen.')));
    browserSteps.hidden = false;
  };
  const browserBox = h('details', { class: 'browser-import' },
    h('summary', {}, t('Direkt aus dem Browser (Chrome, Edge, Firefox)')),
    h('div', { class: 'field-row', style: { marginTop: '8px' } },
      ...BROWSER_GUIDES.map((g) => h('button', { type: 'button', class: `btn small browser-pick browser-${g.id}`, onclick: () => showGuide(g) }, g.name))),
    browserSteps);

  setChildren(body,
    h('p', {}, t('Exportiere die Daten im alten Passwortmanager und wähle die Datei hier aus. Sie wird nur lokal gelesen.')),
    h('ul', { class: 'small muted' }, ...FORMATS.map((f) => h('li', {}, t(f)))),
    browserBox,
    h('div', { class: 'field-row' }, fileInput,
      h('button', { type: 'button', class: 'btn small', onclick: () => downloadSample(ctx) }, icon('download', 14), t('Beispieldatei (CSV)'))),
    kdbxBox, summary, mappingBox, preview, topBox,
    h('div', { class: 'grid2', style: { marginTop: '12px' } },
      h('div', { class: 'field' }, h('label', {}, t('Ziel-Tresor')), container),
      h('div', { class: 'field' }, h('label', {}, ' '), h('label', { class: 'inline' }, skipDuplicates, t('Duplikate überspringen')))),
    progress,
    hint);

  const { dialog, close } = modal(t('Importieren'), body, [{ label: t('Abbrechen') }]);
  dialog.querySelector('.modal-footer').append(importButton);
}
