// Copying secrets: clipboard without history and cloud sync, cleared after the set time; Windows Error Reporting
// exclusion (no memory dumps with secrets).

import { app, clipboard } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { copySecret } from '../autotype.js';
import { t } from '../../extension/core/i18n.js';
import { demo, smokeTest } from './boot.js';
import { config } from './state.js';
import { diag } from './diag.js';
import { helperExe, runHelperExe } from './typing.js';

let clipboardTimer = null;

let psClipboardBlocked = false;

/**
 * Installed app on Windows: exclude Keevault.exe from Windows Error Reporting once per version, so a crash never
 * leaves (or uploads) a memory dump with decrypted entries. Runs quietly in the background.
 */
export function excludeFromErrorReporting() {
  if (process.platform !== 'win32' || !app.isPackaged || config.get().werExcluded === app.getVersion()) return;
  const exe = helperExe();
  if (!exe) return;
  const child = spawn(exe, ['--wer-exclude', path.basename(process.execPath)], { windowsHide: true, stdio: 'ignore' });
  child.on('exit', (code) => { if (code === 0) config.update({ werExcluded: app.getVersion() }); });
  child.on('error', () => {});
}

/** Clipboard with history/cloud markers, read back by the helper itself: true only when the text arrived. */
export const copyViaHelperExe = (text) => runHelperExe('--clipboard', text).then((code) => code === 0);

/**
 * Copies a value. On Windows with the markers that keep it out of the clipboard history (Win+V) and the
 * cloud clipboard – a copied password must not end up in a history or on other devices.
 */
export async function copyToClipboard(text) {
  // Windows: Keevault-Update.exe --clipboard (windows/Setup/Clip.cs) writes with the history/cloud markers and reads
  // the text back itself. Electron's clipboard.readText() returns nothing on some machines (2026-11-01: every copy
  // reported "clipboard not available" although it had worked) – so it decides nothing here any more.
  // Without the helper (development without windows/out): the PowerShell helper, which App Control or endpoint
  // protection may block (then after 1.5 s). Never the plain clipboard on Windows: then the copy fails (#337).
  let verified = false;
  if (process.platform === 'win32') {
    const code = await runHelperExe('--clipboard', text);
    verified = code === 0;
    if (!verified) {
      diag(`COPY Keevault-Update.exe ${code === null ? 'unavailable' : `exit ${code}`} – fallback`);
      const ps = !smokeTest && !demo && !psClipboardBlocked
        && await Promise.race([copySecret(text).then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 1500))]);
      // Neither helper could copy: an error, never a plain copy – that one would land in Windows' clipboard history
      // and the cloud clipboard (#337).
      if (!ps) {
        psClipboardBlocked = true;
        diag('COPY refused: no protected clipboard (helper and PowerShell failed)');
        throw new Error(t('Kopieren nicht möglich: Die geschützte Zwischenablage ist nicht verfügbar. Bitte Keevault neu starten.'));
      }
    }
  } else {
    clipboard.writeText(text);
  }
  if (!verified) {
    // Electron's read-back: only another text counts as failure – an empty or missing result says nothing.
    const back = clipboard.readText();
    if (typeof back === 'string' && back && back !== text) throw new Error(t('Die Zwischenablage ist nicht verfügbar.'));
  }
  clearTimeout(clipboardTimer);
  const seconds = Number(config.get().clipboardSeconds) || 0;
  if (seconds > 0) {
    // Cleared only if it still holds this text (something copied since stays) – compared by the helper on Windows.
    clipboardTimer = setTimeout(async () => {
      const code = process.platform === 'win32' ? await runHelperExe('--clipboard-clear', text) : null;
      if (code === null && clipboard.readText() === text) clipboard.clear();
    }, seconds * 1000);
  }
}
