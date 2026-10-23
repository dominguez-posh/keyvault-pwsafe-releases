// Import wizard shared by the extension options page and the desktop app.
// ctx: { containers: [{ id, name }] (writable, unlocked), defaultContainer, existing(containerId) → summaries,
//        save(containerId, items, onProgress(done, total)) → { imported, errors }, download(filename, text) }

import { h, icon, modal, toast, setChildren } from './dom.js';
import { parseImport, applyCsvMapping, CSV_TARGETS, CSV_TARGET_LABELS, duplicateKey } from './importer.js';
import { SAMPLE_CSV } from './import-sample.js';
import { t } from './i18n.js';

const FORMATS = [
  'Bitwarden: JSON (unverschlüsselt, inkl. Passkeys) oder CSV',
  '1Password: 1PUX oder CSV',
  'KeePass / KeePassXC: XML oder CSV (inkl. KeePassXC-Passkeys)',
  'Edge, Chrome, Firefox: CSV',
  'Allgemein: CSV mit frei zuordenbaren Spalten',
];

export function downloadSample(ctx) {
  ctx.download('kvpwsafe-import-sample.csv', SAMPLE_CSV);
}

export function importDialog(ctx) {
  if (!ctx.containers.length) {
    toast(t('Kein entsperrter Tresor mit Schreibrechten verfügbar'), 'error');
    return;
  }
  const body = h('div', {});
  const fileInput = h('input', { type: 'file', accept: '.csv,.json,.xml,.1pux,.txt,.zip' });
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

  const renderPreview = () => {
    items = parsed.csv ? applyCsvMapping(parsed.csv.columns, parsed.csv.rows, mapping) : parsed.items;
    const passkeys = items.reduce((n, i) => n + i.passkeys.length, 0);
    const notes = items.filter((i) => i.type === 'note').length;
    setChildren(summary, h('p', {}, h('b', {}, parsed.label), ' · ',
      t('{count} Einträge', { count: items.length }),
      passkeys ? ` · ${t('{count} Passkeys', { count: passkeys })}` : '',
      notes ? ` · ${t('{count} Notizen', { count: notes })}` : ''));
    setChildren(preview, items.slice(0, 8).map((i) => h('div', { class: 'row-sub' }, `${i.title}${i.username ? ` – ${i.username}` : ''}${i.folder ? ` (${i.folder})` : ''}`)),
      items.length > 8 ? h('div', { class: 'row-sub' }, t('… und {count} weitere', { count: items.length - 8 })) : null);
    importButton.disabled = !items.length;
  };

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

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      parsed = await parseImport({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      mapping = parsed.csv ? [...parsed.csv.mapping] : null;
      renderMapping();
      renderPreview();
    } catch (e) {
      parsed = null;
      importButton.disabled = true;
      setChildren(summary, h('div', { class: 'notice error' }, e.message));
      setChildren(preview);
      setChildren(mappingBox);
    }
  });

  importButton.addEventListener('click', async () => {
    importButton.disabled = true;
    try {
      let list = items;
      let skipped = 0;
      if (skipDuplicates.checked) {
        const existing = new Set((await ctx.existing(container.value)).map(duplicateKey));
        list = items.filter((i) => !existing.has(duplicateKey(i)));
        skipped = items.length - list.length;
      }
      progress.hidden = false;
      progress.max = Math.max(1, list.length);
      const r = await ctx.save(container.value, list, (done) => { progress.value = done; });
      toast(t('{imported} von {total} Einträgen importiert', { imported: r.imported, total: items.length }) + (skipped ? ` · ${t('{count} Duplikate übersprungen', { count: skipped })}` : ''));
      close();
      if (r.errors?.length) modal(t('Nicht importiert'), h('pre', { class: 'errors' }, r.errors.join('\n')));
      ctx.onDone?.();
    } catch (e) {
      toast(e.message, 'error');
      importButton.disabled = false;
    }
  });

  setChildren(body,
    h('p', {}, t('Exportiere die Daten im alten Passwortmanager und wähle die Datei hier aus. Sie wird nur lokal gelesen.')),
    h('ul', { class: 'small muted' }, ...FORMATS.map((f) => h('li', {}, t(f)))),
    h('div', { class: 'field-row' }, fileInput,
      h('button', { type: 'button', class: 'btn small', onclick: () => downloadSample(ctx) }, icon('download', 14), t('Beispieldatei (CSV)'))),
    summary, mappingBox, preview,
    h('div', { class: 'grid2', style: { marginTop: '12px' } },
      h('div', { class: 'field' }, h('label', {}, t('Ziel-Tresor')), container),
      h('div', { class: 'field' }, h('label', {}, ' '), h('label', { class: 'inline' }, skipDuplicates, t('Duplikate überspringen')))),
    progress,
    h('p', { class: 'muted small' }, t('Lösche die Exportdatei nach dem Import sicher – sie enthält alle Passwörter im Klartext.')));

  const { dialog, close } = modal(t('Importieren'), body, [{ label: t('Abbrechen') }]);
  dialog.querySelector('.modal-footer').append(importButton);
}
