// Encrypted backups: the pending backup/restore of this run and the printable sheet with the one-time password.

import { BrowserWindow } from 'electron';
import { t } from '../../extension/core/i18n.js';

export let lastBackup = null;
export let pendingRestore = null;

const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

export function backupSheetHtml(b) {
  const row = (label, value) => `<tr><th>${escHtml(label)}</th><td>${escHtml(value)}</td></tr>`;
  return `<!doctype html><html lang="de"><meta charset="utf-8"><title>${escHtml(t('Keevault – Backup-Passwort'))}</title>
<style>body{font:14px/1.5 "Segoe UI",Arial,sans-serif;margin:40px;color:#000}h1{font-size:22px;margin:0 0 4px}
table{border-collapse:collapse;margin:16px 0}th,td{text-align:left;padding:4px 16px 4px 0;vertical-align:top}
.pw{font:bold 26px/1.4 Consolas,monospace;letter-spacing:2px;border:2px solid #000;padding:14px 18px;margin:18px 0;display:inline-block}
.warn{border:2px solid #000;padding:12px 16px;margin-top:18px}.warn b{display:block;margin-bottom:6px}</style>
<h1>${escHtml(t('Keevault – Backup-Passwort'))}</h1>
<p>${escHtml(t('Dieses Blatt gehört zu genau einem Backup. Ohne das Passwort lässt sich das Backup nicht wiederherstellen.'))}</p>
<table>${row(t('Tresor'), `${b.name} (${b.vault})`)}${row(t('Backup-Datei'), b.file)}${row(t('Erstellt'), new Date(b.created).toLocaleString())}${row(t('Erstellt von'), b.by)}${row(t('Einträge (Secrets)'), b.count)}</table>
<div class="pw">${escHtml(b.password)}</div>
<div class="warn"><b>${escHtml(t('Wichtig – bitte sicher aufbewahren'))}</b>
${escHtml(t('Das Passwort wird nur dieses eine Mal angezeigt und ist nirgends gespeichert – auch nicht beim Hersteller. Geht es verloren, ist das Backup unbrauchbar.'))}<br>
${escHtml(t('Wer Backup-Datei und Passwort hat, kann alle Passwörter dieses Tresors lesen. Bewahre dieses Blatt getrennt von der Datei an einem sicheren Ort auf, z. B. im Tresor oder Bankschließfach.'))}<br>
${escHtml(t('Für die sichere Aufbewahrung von Backup-Datei und Passwort ist der Kunde selbst verantwortlich.'))}</div>
</html>`;
}

/** Prints HTML through the system print dialog (printer or "Microsoft Print to PDF"). */
export async function printHtml(html) {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve, reject) => w.webContents.print({ printBackground: false }, (ok, reason) => (ok || reason === 'cancelled' ? resolve() : reject(new Error(reason)))));
  } finally {
    w.destroy();
  }
}

// Other modules read these bindings directly and change them through the setters (imports are read-only).
export function setLastBackup(value) { lastBackup = value; return value; }
export function setPendingRestore(value) { pendingRestore = value; return value; }
