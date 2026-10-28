// Reports of the desktop app: password health (weak, reused, old, leaked) and the access report for audits
// (who may do what in which Key Vault). Both read through the main process (api.healthReport / accessReport).

import { h, icon, modal, toast, setChildren } from '../../extension/core/dom.js';
import { t } from '../../extension/core/i18n.js';

const LEVELS = { manage: 'Verwalten', write: 'Bearbeiten', read: 'Lesen', none: 'Keine Datenrechte' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** CSV for Excel (German locale): semicolon, quoted fields, UTF-8 with BOM. */
export function csv(headers, rows) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return `﻿${[headers, ...rows].map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
}

/** Printable page for "Save as PDF" (all values escaped). */
export function reportHtml(title, meta, headers, rows) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:12px/1.4 "Segoe UI",Arial,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0 0 4px}.meta{color:#555;margin-bottom:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:5px 8px;border-bottom:1px solid #ddd}th{border-bottom:2px solid #111;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
tr{page-break-inside:avoid}</style></head><body><h1>${esc(title)}</h1><div class="meta">${esc(meta)}</div>
<table><thead><tr>${headers.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
}

const exportButtons = (name, title, meta, headers, rows, call) => h('div', { class: 'inline' },
  h('button', { type: 'button', class: 'btn small', onclick: async () => {
    try {
      if (await call('saveTextFile', { name: `${name}.csv`, text: csv(headers, rows) })) toast(t('CSV gespeichert'));
    } catch (e) {
      toast(e.message, 'error');
    }
  } }, icon('download', 14), t('CSV exportieren')),
  h('button', { type: 'button', class: 'btn small', onclick: async () => {
    try {
      if (await call('saveReportPdf', { name: `${name}.pdf`, html: reportHtml(title, meta, headers, rows) })) toast(t('PDF gespeichert'));
    } catch (e) {
      toast(e.message, 'error');
    }
  } }, icon('download', 14), t('Als PDF speichern')));

/**
 * Password check. ctx: { call, containerName(id), openItem({ containerId, key }), containerId? }
 * The Have-I-Been-Pwned check is opt-in and remembered (only the first 5 hex digits of the SHA-1 leave the PC).
 */
export async function healthDialog(ctx) {
  const body = h('div', {});
  let remembered = false;
  try {
    remembered = localStorage.getItem('hibp') === '1';
  } catch {
    // Storage unavailable: start unchecked.
  }
  const hibp = h('input', { type: 'checkbox', checked: remembered });
  const scopeLabel = ctx.containerId ? ctx.containerName(ctx.containerId) : t('alle Tresore');
  const { close } = modal(t('Passwort-Check'), h('div', {},
    h('p', { class: 'muted small' }, t('Prüft {scope}: schwache, mehrfach verwendete und seit über einem Jahr unveränderte Passwörter. Notizen und Einträge ohne Passwort bleiben außen vor.', { scope: scopeLabel })),
    h('label', { class: 'inline' }, hibp, t('Auch gegen bekannte Datenlecks prüfen (Have I Been Pwned) – nur die ersten 5 Zeichen des Hashes verlassen den PC')),
    body), [{ label: t('Schließen') }]);
  const run = async () => {
    try {
      localStorage.setItem('hibp', hibp.checked ? '1' : '0');
    } catch {
      // Not remembered then.
    }
    setChildren(body, h('p', {}, h('span', { class: 'spinner' }), ' ', t('Passwörter werden geladen und geprüft …')));
    let r;
    try {
      r = await ctx.call('healthReport', { containerIds: ctx.containerId ? [ctx.containerId] : [], hibp: hibp.checked });
    } catch (e) {
      setChildren(body, h('p', { class: 'notice' }, e.message));
      return;
    }
    const { counts } = r;
    const badge = (cls, label, title) => h('span', { class: `badge ${cls}`, title }, label);
    const rows = r.items.map((i) => [ctx.containerName(i.containerId), i.folder, i.title, i.username,
      [i.weak ? t('schwach') : '', i.reused ? t('mehrfach') : '', i.old ? t('alt') : '', i.pwned ? t('geleakt ({n}×)', { n: i.pwned }) : ''].filter(Boolean).join(', ')]);
    setChildren(body,
      h('p', {}, t('{checked} Passwörter geprüft: {weak} schwach, {reused} mehrfach verwendet, {old} älter als ein Jahr{pwned}.', {
        checked: counts.checked, weak: counts.weak, reused: counts.reused, old: counts.old,
        pwned: hibp.checked ? t(', {n} in bekannten Datenlecks', { n: counts.pwned || 0 }) : '',
      }), r.skipped ? ` ${t('{n} Einträge in gesperrten Tresoren übersprungen.', { n: r.skipped })}` : ''),
      r.items.length ? h('div', { class: 'table' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, t('Eintrag')), h('th', {}, t('Tresor')), h('th', {}, t('Befund')), h('th', {}))),
        h('tbody', {}, ...r.items.map((i) => h('tr', {},
          h('td', {}, h('b', {}, i.title), i.username ? h('div', { class: 'muted small' }, i.username) : null),
          h('td', {}, [ctx.containerName(i.containerId), i.folder].filter(Boolean).join(' / ')),
          h('td', { class: 'inline' },
            i.weak ? badge('danger', t('schwach'), t('Zu kurz oder zu vorhersehbar – ein generiertes Passwort mit 16+ Zeichen ist sicherer.')) : null,
            i.reused ? badge('warn', t('mehrfach'), t('Dasselbe Passwort steckt in mehreren Einträgen – ein Leck trifft dann alle.')) : null,
            i.old ? badge('', t('alt'), t('Seit über einem Jahr nicht geändert.')) : null,
            i.pwned ? badge('danger', t('geleakt ({n}×)', { n: i.pwned }), t('Dieses Passwort taucht in bekannten Datenlecks auf – bitte sofort ändern.')) : null),
          h('td', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn small', onclick: () => {
            close();
            ctx.openItem(i);
          } }, t('Öffnen')))))))) : h('p', { class: 'notice ok' }, icon('shield', 16), ' ', t('Keine Auffälligkeiten – alle geprüften Passwörter sind in Ordnung.')),
      r.items.length ? exportButtons(`Keevault-Passwort-Check-${new Date().toISOString().slice(0, 10)}`, t('Passwort-Check'), t('{scope} · erstellt {date}', { scope: scopeLabel, date: new Date().toLocaleString() }),
        [t('Tresor'), t('Ordner'), t('Eintrag'), t('Benutzername'), t('Befund')], rows, ctx.call) : null,
    );
  };
  hibp.addEventListener('change', run);
  await run();
}

/** Access report: every role assignment on the Key Vault vaults (incl. inherited ones), as table, CSV and PDF. */
export async function accessReportDialog(ctx) {
  const body = h('div', {}, h('p', {}, h('span', { class: 'spinner' }), ' ', t('Rollenzuweisungen werden gelesen …')));
  modal(t('Zugriffsbericht'), h('div', {},
    h('p', { class: 'muted small' }, t('Wer darf was in deinen Key-Vault-Tresoren – aus Azure RBAC gelesen, inklusive vererbter Rollen aus Ressourcengruppe und Subscription. Für Audits (z. B. ISO 27001) als CSV oder PDF speichern.')),
    body), [{ label: t('Schließen') }]);
  let r;
  try {
    r = await ctx.call('accessReport');
  } catch (e) {
    setChildren(body, h('p', { class: 'notice' }, e.message));
    return;
  }
  const ok = r.rows.filter((x) => !x.error);
  const failed = r.rows.filter((x) => x.error);
  const headers = [t('Tresor'), t('Person / Gruppe'), t('Konto'), t('Typ'), t('Rechte'), t('Rollen')];
  const rows = ok.map((x) => [x.vault, x.principal, x.detail, x.type, t(LEVELS[x.level] || x.level), x.roles.join(', ')]);
  const meta = t('Erstellt {date} von {user} · {n} Zuweisungen in {vaults} Tresoren', { date: new Date(r.created).toLocaleString(), user: r.by, n: ok.length, vaults: new Set(ok.map((x) => x.vault)).size });
  setChildren(body,
    h('p', { class: 'muted small' }, meta),
    failed.length ? h('p', { class: 'notice' }, t('Nicht lesbar: {list}', { list: failed.map((x) => `${x.vault} (${x.error})`).join('; ') })) : null,
    ok.length ? h('div', { class: 'table' }, h('table', {},
      h('thead', {}, h('tr', {}, ...headers.map((x) => h('th', {}, x)))),
      h('tbody', {}, ...rows.map((cells) => h('tr', {}, ...cells.map((c) => h('td', {}, c))))))) : h('p', { class: 'muted' }, t('Keine Rollenzuweisungen gefunden.')),
    ok.length ? exportButtons(`Keevault-Zugriffsbericht-${new Date().toISOString().slice(0, 10)}`, t('Zugriffsbericht'), meta, headers, rows, ctx.call) : null,
  );
}
