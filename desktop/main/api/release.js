// API: release signing (#378). The only place that imports the signing module (npm run check): no MCP tool, bridge
// command or Windows-provider message leads here. The menu entries exist only when the app is allowed to sign.

import { app, clipboard, dialog, screen } from 'electron';
import { smokeTest } from '../boot.js';
import { win } from '../state.js';
import { requireOpen } from '../guards.js';
import { cardPlacement, confirmInCard } from '../confirm-card.js';
import { createReleaseRemoval, createReleaseSetup, createReleaseSigning, keyStore, openApprovalDialog, refusal, releaseApprovers, removeReleaseApprover, setupReleaseKey, signReleaseFolder, testKeyStore } from '../release-sign.js';

export const releaseApi = {
  async releaseSigningStatus() {
    const why = refusal();
    return { available: !why, reason: why, hasKey: !why && keyStore().hasKey(), approvers: why ? 0 : (await keyStore().approvers()).length };
  },
  /** Menu "Release signieren": the folder is chosen here, in the main process. → { version, file } | null */
  async signRelease() {
    requireOpen();
    const why = refusal();
    if (why) throw new Error(why);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Release-Ordner wählen (mit latest.yml)', properties: ['openDirectory'] });
    if (canceled || !filePaths[0]) return null;
    const done = await signReleaseFolder(filePaths[0], win);
    if (done) await dialog.showMessageBox(win, { type: 'info', message: `Keevault ${done.version} signiert`, detail: `${done.file} geschrieben.`, buttons: ['OK'] });
    return done;
  },
  /** Menu "Release-Schlüssel einrichten": hardware key as approver; its UPDATE_KEYS element goes to the clipboard. */
  async setupReleaseKey() {
    requireOpen();
    const done = await setupReleaseKey(win);
    if (!done) return null; // cancelled in the dialog: nothing was changed
    clipboard.writeText(done.publicKey);
    await dialog.showMessageBox(win, { type: 'info', message: 'Release-Freigeber eingetragen', detail: `Dieses Element kommt in UPDATE_KEYS (desktop/update-verify.js); es liegt in der Zwischenablage:\n\n${done.publicKey}\n\nEingetragene Sicherheitsschlüssel: ${done.approvers.length}.`, buttons: ['OK'] });
    return { publicKey: done.publicKey, count: done.approvers.length };
  },
  /** Menu "Release-Freigeber anzeigen" (#437): the registered security keys with their UPDATE_KEYS elements (public parts only). */
  async showReleaseApprovers() {
    requireOpen();
    const why = refusal();
    if (why) throw new Error(why);
    const { approvers } = await releaseApprovers(keyStore());
    if (!approvers.length) {
      await dialog.showMessageBox(win, { type: 'info', message: 'Noch kein Release-Freigeber eingetragen', detail: 'Mit „Release-Schlüssel einrichten“ einen FIDO2-Sicherheitsschlüssel eintragen.', buttons: ['OK'] });
      return { count: 0 };
    }
    const text = approvers.map((a) => a.line).join('\n');
    const { response } = await dialog.showMessageBox(win, {
      type: 'info', message: `Release-Freigeber: ${approvers.length}`,
      detail: `Diese Elemente stehen (oder gehören) in UPDATE_KEYS. Ein Sicherheitsschlüssel bleibt dort, bis eine neue Version ihn entfernt:\n\n${text}`,
      buttons: ['Kopieren', 'Schließen'], defaultId: 1, cancelId: 1,
    });
    if (response === 0) clipboard.writeText(text);
    return { count: approvers.length };
  },
  /**
   * Menu "Release-Freigeber entfernen" (#437, lost key): the key to remove is picked here, in the main process (nothing
   * comes from the window); another registered key confirms in the waiting-time dialog. → { count } | null
   */
  async removeReleaseApprover() {
    requireOpen();
    const why = refusal();
    if (why) throw new Error(why);
    const { approvers } = await releaseApprovers(keyStore());
    if (approvers.length < 2) {
      await dialog.showMessageBox(win, { type: 'info', message: 'Kein Freigeber entfernbar', detail: `Eingetragen: ${approvers.length}. Der letzte Freigeber lässt sich nicht entfernen; erst einen weiteren Sicherheitsschlüssel eintragen.`, buttons: ['OK'] });
      return { count: approvers.length };
    }
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', message: 'Welchen Release-Freigeber entfernen?',
      detail: 'Danach bestätigt ein anderer eingetragener Sicherheitsschlüssel das Entfernen.',
      buttons: [...approvers.map((a) => `${a.id} (${a.credentialId.slice(0, 12)}…)`), 'Abbrechen'], defaultId: approvers.length, cancelId: approvers.length,
    });
    const target = approvers[response];
    if (!target) return null;
    const done = await removeReleaseApprover(target.credentialId, win);
    if (!done) return null; // cancelled in the dialog: nothing was changed
    await dialog.showMessageBox(win, { type: 'info', message: `Release-Freigeber ${target.id} entfernt`, detail: `Eingetragene Sicherheitsschlüssel: ${done.approvers.length}.\n\nSein Element in UPDATE_KEYS (desktop/update-verify.js) gilt in ausgelieferten Versionen weiter: in der nächsten Version entfernen.`, buttons: ['OK'] });
    return { count: done.approvers.length };
  },
};

/**
 * Smoke hook (desktop/main/smoke.js): the signing flow with a test key store and the real dialog window, hidden. Not part
 * of the API object above, so the window cannot call it; refuses to run in an installed app.
 */
export function smokeRelease(deps) {
  if (!smokeTest || app.isPackaged) throw new Error('smokeRelease nur im Testlauf');
  return { sign: (extra) => createReleaseSigning({ refusal: () => null, ...deps, ...extra }),
    setup: (extra) => createReleaseSetup({ refusal: () => null, ...deps, ...extra }),
    remove: (extra) => createReleaseRemoval({ refusal: () => null, ...deps, ...extra }),
    openApprovalDialog, testKeyStore, confirmInCard, cardPlacement, workAreas: () => screen.getAllDisplays().map((d) => d.workArea) };
}
