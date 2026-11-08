// Smoke check #473: a plaintext export asks for the app PIN. In the main process: no confirmation, a wrong PIN and a
// used confirmation are refused. In the window: the export menu shows the warning and the PIN field, a wrong PIN
// writes no file and keeps the dialog open, the right PIN exports. Called with a PIN set and the vault id unlocked.

import fs from 'node:fs/promises';
import path from 'node:path';

const exists = (file) => fs.access(file).then(() => true, () => false);

export async function exportPinCheck({ api, js, sleep, errors, id, dir }) {
  const file = process.env.KVPWSAFE_TEST_EXPORT = path.join(dir, 'export-473.csv');
  try {
    if (await api.exportItems(id).then(() => true, () => false)) errors.push('export PIN: exported without a PIN confirmation');
    if (await api.confirmExportPin(id, '0000').then(() => true, () => false)) errors.push('export PIN: wrong PIN confirmed');
    const token = await api.confirmExportPin(id, '246813').catch((e) => errors.push(`export PIN: right PIN refused (${e.message})`));
    if (await api.exportItems('another-vault', token).then(() => true, () => false)) errors.push('export PIN: confirmation used for another vault');
    if (await api.exportItems(id, token).then(() => true, () => false)) errors.push('export PIN: confirmation used twice');
    if (await exists(file)) errors.push('export PIN: a refused export wrote the file');

    // The window: context menu of the personal vault → export dialog with warning and PIN field.
    await js('(() => { const row = document.querySelector(".personal-slot .nav-row"); row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 60, clientY: 200 })); document.querySelector(".context-menu [data-action=export]")?.click(); })()');
    let dlg = '';
    for (let i = 0; i < 10 && !dlg; i++) { await sleep(300); dlg = await js('document.querySelector("dialog[open]")?.textContent || ""'); }
    if (!/Unverschlüsselter Export|Unencrypted export/.test(dlg) || !/im Klartext|in plain text/.test(dlg)) errors.push('personal export: menu entry or unencrypted-export warning missing');
    if (!(await js('!!document.querySelector("dialog[open] .export-pin")'))) errors.push('export PIN: the export dialog asks for no app PIN');
    const submit = (pin) => js(`(() => { const p = document.querySelector("dialog[open] .export-pin"); if (!p) return false; p.value = ${JSON.stringify(pin)}; document.querySelector("dialog[open] .modal-footer .btn.danger")?.click(); return true; })()`);
    await submit('0000');
    await sleep(1500);
    if (await exists(file)) errors.push('export PIN: wrong PIN in the dialog exported');
    if (!(await js('!!document.querySelector("dialog[open] .export-pin")'))) errors.push('export PIN: dialog closed after a wrong PIN');
    await submit('246813');
    let csv = '';
    for (let i = 0; i < 20 && !csv; i++) { await sleep(300); csv = await fs.readFile(file, 'utf8').catch(() => ''); }
    if (!csv.includes('Privat')) errors.push('export PIN: right PIN in the dialog did not export');
    if (await js('!!document.querySelector("dialog[open] .export-pin")')) errors.push('export PIN: dialog still open after the export');
  } finally {
    delete process.env.KVPWSAFE_TEST_EXPORT;
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click())');
    await fs.rm(file, { force: true });
  }
}
