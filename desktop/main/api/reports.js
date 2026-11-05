// API: password check, access report and saving reports.

import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { secureFetch } from '../../secure-net.js';
import { mapLimit } from '../../../extension/core/util.js';
import { passwordReport, hibpParts, hibpCount, passkeyRecommendations } from '../../../extension/core/health.js';
import { t } from '../../../extension/core/i18n.js';
import { smokeTest } from '../boot.js';
import { vault, win } from '../state.js';
import { diag } from '../diag.js';
import { requireOpen } from '../guards.js';
import { actor, containerResource, send } from '../session.js';

/**
 * Websites that support passkeys: the 2FA Directory's public list (passkeys.2fa.directory), kept for a day in memory
 * and as a file in the profile (used when offline). Smoke tests set KVPWSAFE_TEST_PASSKEY_DIRECTORY (JSON).
 */
const PASSKEY_DIRECTORY_URL = 'https://passkeys-api.2fa.directory/v1/supported.json';
let passkeyDirectoryCache = null; // { at, data }
async function passkeyDirectory() {
  if (smokeTest && process.env.KVPWSAFE_TEST_PASSKEY_DIRECTORY) return JSON.parse(process.env.KVPWSAFE_TEST_PASSKEY_DIRECTORY);
  if (passkeyDirectoryCache && Date.now() - passkeyDirectoryCache.at < 86_400_000) return passkeyDirectoryCache.data;
  const file = path.join(app.getPath('userData'), 'passkey-directory.json');
  try {
    const res = await secureFetch(PASSKEY_DIRECTORY_URL, { headers: { 'User-Agent': 'Keevault' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || typeof data !== 'object') throw new Error('unexpected format');
    passkeyDirectoryCache = { at: Date.now(), data };
    await fs.writeFile(file, JSON.stringify(data)).catch(() => {});
    return data;
  } catch (e) {
    const saved = JSON.parse(await fs.readFile(file, 'utf8').catch(() => 'null'));
    if (saved) return saved;
    throw e;
  }
}

export const reportsApi = {
  /** Password health over the given vaults (all open ones when empty); hibp: also ask Have I Been Pwned. */
  async healthReport({ containerIds = [], hibp = false } = {}) {
    requireOpen();
    const wanted = (await vault.summaries()).filter((s) => (!containerIds.length || containerIds.includes(s.containerId)) && s.type !== 'note');
    const items = [];
    let skipped = 0;
    let done = 0;
    await mapLimit(wanted, 6, async (s) => {
      try {
        items.push(await vault.getItem(s.containerId, s.id));
      } catch {
        skipped++; // locked (protected) vault or transient error
      }
      send({ type: 'progress', id: 'healthReport', done: ++done, total: wanted.length });
    });
    if (hibp) {
      const ranges = new Map(); // prefix → response text (several passwords can share a prefix)
      await mapLimit(items.filter((i) => i.password), 4, async (i) => {
        const { prefix, suffix } = await hibpParts(i.password);
        if (!ranges.has(prefix)) {
          ranges.set(prefix, secureFetch(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true', 'User-Agent': 'Keevault' } })
            .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HIBP HTTP ${res.status}`)))));
        }
        i.pwnedCount = hibpCount(await ranges.get(prefix), suffix);
      });
    }
    // Passkey recommendations (#26): the public directory is downloaded (nothing about the vault leaves the PC).
    const directory = await passkeyDirectory().catch((e) => { diag(`PASSKEY directory: ${e.message}`); return null; });
    return { ...passwordReport(items), skipped, hibp, passkeys: passkeyRecommendations(items, directory), passkeyDirectory: !!directory };
  },
  /** Who may do what in the Key Vault vaults (role assignments incl. inherited ones) – for audits. */
  async accessReport() {
    requireOpen();
    const rows = [];
    const containers = (await vault.containers()).filter((c) => c.kind === 'keyvault' && !c.error);
    let done = 0;
    await mapLimit(containers, 3, async (c) => {
      send({ type: 'progress', id: 'accessReport', done, total: containers.length });
      try {
        const members = await (await vault.azureForId(c.id)).listMembers(await containerResource(c.id));
        for (const m of members) {
          rows.push({
            vault: c.name, vaultUrl: c.vaultUrl, principal: m.displayName, detail: m.detail || '', type: m.principalType || '', level: m.level,
            roles: m.assignments.map((a) => a.label + (a.inherited ? ` (${t('vererbt')})` : '')),
          });
        }
      } catch (e) {
        rows.push({ vault: c.name, vaultUrl: c.vaultUrl, error: e.message });
      }
      send({ type: 'progress', id: 'accessReport', done: ++done, total: containers.length });
    });
    rows.sort((a, b) => a.vault.localeCompare(b.vault) || (a.principal || '').localeCompare(b.principal || ''));
    return { created: new Date().toISOString(), by: actor(), rows };
  },
  /** Saves a text file (CSV) where the user chooses. */
  async saveTextFile({ name, text }) {
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), String(name).replace(/[\\/:*?"<>|]/g, '_')) });
    if (canceled || !filePath) return false;
    await fs.writeFile(filePath, String(text), 'utf8');
    return true;
  },
  /** Renders a report page off-screen and saves it as PDF. */
  async saveReportPdf({ name, html }) {
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), String(name).replace(/[\\/:*?"<>|]/g, '_')), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (canceled || !filePath) return false;
    const page = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
    try {
      await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(String(html))}`);
      await fs.writeFile(filePath, await page.webContents.printToPDF({ printBackground: true, landscape: true }));
    } finally {
      page.destroy();
    }
    return true;
  },
};
