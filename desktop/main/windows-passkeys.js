// Windows passkey provider: requests from Windows shown in the window, and its registration.

import { app, shell, dialog } from 'electron';
import { t } from '../../extension/core/i18n.js';
import { providerStatus, ensureProvider, machineSetupStatus } from '../windows-provider.js';
import { smokeTest } from './boot.js';
import { config, win, windows } from './state.js';
import { api } from './api/index.js';

export let windowStateBeforeRequest = null;

/** After a Windows passkey request: back to the tray (or minimized) if the window was not open before. */
export function restoreAfterWindowsRequest() {
  if (!win) return;
  win.setAlwaysOnTop(false);
  const before = windowStateBeforeRequest;
  windowStateBeforeRequest = null;
  if (smokeTest) return;
  if (before === 'hidden') win.hide();
  else if (before === 'minimized') win.minimize();
}

export const windowsHandlers = {
  hello: async () => ({ version: app.getVersion() }),
  'win:status': async () => windows.status(),
  'win:makeCredential': (msg) => windows.request('create', msg),
  'win:getAssertion': (msg) => windows.request('get', msg),
  'win:cancel': async ({ transactionId }) => windows.cancel(transactionId),
};

/**
 * Installed app, every start: provider for this user. Missing device-wide parts (certificate trust, extension
 * policy) are reported once per version with the option to set them up with administrator rights.
 */
export async function setupWindowsProvider() {
  // Until 0.9.0 the provider was installed for everyone: where it is there and nobody chose, it stays on.
  if (app.isPackaged && process.platform === 'win32' && !config.has('windowsProvider') && (await providerStatus().catch(() => ({}))).installed) {
    config.update({ windowsProvider: true });
  }
  if (!config.get().windowsProvider && !config.get().browserIntegration) return;
  let status = config.get().windowsProvider ? await ensureProvider(`${app.getVersion()}.0`) : null;
  const machine = await machineSetupStatus();
  const missing = [
    status?.installError || (config.get().windowsProvider && !machine.certTrusted)
      ? t('Passkey-Anbieter: Windows vertraut dem Zertifikat des Pakets noch nicht.') : null,
    config.get().browserIntegration && !machine.edgePolicy ? t('Browser-Erweiterung: Die Richtlinie zur Installation in Edge/Chrome fehlt.') : null,
  ].filter(Boolean);
  if (missing.length && config.get().machineSetupHint !== app.getVersion()) {
    config.update({ machineSetupHint: app.getVersion() });
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [t('Mit Administratorrechten einrichten'), t('Später')],
      defaultId: 0,
      cancelId: 1,
      message: t('Für Keevault fehlt noch eine Einrichtung auf diesem Gerät.'),
      detail: `${missing.join('\n')}\n\n${t('Das richtet eure IT einmal pro Gerät ein (Intune-Skript „Keevault-Geraet-Einrichten.ps1“) – oder du machst es jetzt mit Administratorrechten. Alles andere funktioniert schon.')}`,
    });
    if (r.response === 0) {
      await api.runMachineSetup().catch((e) => dialog.showErrorBox(t('Einrichtung fehlgeschlagen'), e.message));
      if (config.get().windowsProvider) status = await ensureProvider(`${app.getVersion()}.0`);
    }
  }
  if (!status) return;
  // Switched from the stand-alone package (0.9.0 and earlier): Windows wants the provider switched on again.
  if (status.migrated) config.update({ windowsProviderHint: false });
  if (!status.registered || status.enabled || config.get().windowsProviderHint) return;
  config.update({ windowsProviderHint: true });
  const r = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: [t('Windows-Einstellungen öffnen'), t('Später')],
    defaultId: 0,
    cancelId: 1,
    message: t('Keevault ist als Passkey-Anbieter eingerichtet.'),
    detail: t('Schalte ihn einmal in Windows ein: Einstellungen → Konten → Passkeys → Erweiterte Optionen → „Keevault“. Danach steht er auch in anderen Browsern und Apps zur Verfügung.'),
  });
  if (r.response === 0) shell.openExternal('ms-settings:savedpasskeys');
}

// Other modules read these bindings directly and change them through the setters (imports are read-only).
export function setWindowStateBeforeRequest(value) { windowStateBeforeRequest = value; return value; }
