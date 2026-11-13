// Smoke check of #531, called by firstStartCheck (desktop/smoke-first-start.js) at the FIDO step of the personal vault
// wizard: the step says nothing is stored, registers a security key itself (the run's virtual USB authenticator, with
// PRF), then shows it as "FIDO-Stick hinterlegt", named as a security key and not "Desktop-App". A second USB
// authenticator without PRF gets the message about PRF (hmac-secret) in the passkey window, and nothing is added.

import { BrowserWindow, webContents } from 'electron';
import { until } from './smoke-wait.js';

const PERSONAL = 'dialog[open].wizard-modal .wizard:not(.vault-wizard):not(.first-start-wizard)';
const passkeyContents = () => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.kvAuthenticator);

export async function fidoStepCheck({ js, fail }) {
  const no = (what) => fail('fidostep', what);
  const state = () => js(`document.querySelector(${JSON.stringify(`${PERSONAL} .wizard-fido`)})?.dataset.fido || ""`);
  const noticeText = () => js(`document.querySelector(${JSON.stringify(`${PERSONAL} .wizard-fido`)})?.textContent || ""`);
  const addKey = () => js(`[...document.querySelectorAll(${JSON.stringify(`${PERSONAL} .wizard-buttons .btn`)})].find((b) => /FIDO/.test(b.textContent))?.click(); true`);

  if ((await until(state, 4000)) !== 'none') return no(`FIDO step before adding: "${await state()}" instead of "none"`);

  // With PRF: added, recognised, named by what it is.
  await addKey();
  if (!(await until(async () => (await state()) === 'key', 25000))) {
    return no(`security key with PRF not recognised: "${await state()}", step text "${await noticeText()}", message "${await js('document.getElementById("toast")?.textContent || ""')}"`);
  }
  const text = await noticeText();
  if (/Desktop-App|Desktop app/.test(text)) no(`security key named as the desktop app: "${text}"`);
  if (!/Sicherheitsschlüssel|Security key/.test(text)) no(`security key not named as one: "${text}"`);

  // Without PRF: a second USB authenticator answers, the one with PRF waits for a touch that never comes.
  const wc = passkeyContents();
  if (!wc) return no('no virtual authenticator of the passkey window');
  const dbg = wc.debugger;
  let noPrf = null;
  try {
    noPrf = (await dbg.sendCommand('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: false, automaticPresenceSimulation: true },
    })).authenticatorId;
    await dbg.sendCommand('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: wc.kvAuthenticator, enabled: false });
    await addKey();
    const shown = await until(() => wc.executeJavaScript('document.body.innerText').then((s) => (/hmac-secret/.test(s) ? s : ''), () => ''), 20000);
    if (!shown) no(`security key without PRF: no message about PRF in the passkey window ("${await wc.executeJavaScript('document.body.innerText').catch((e) => e.message)}")`);
    // Closing the passkey window ends the ceremony; the step still shows the one key with PRF.
    BrowserWindow.fromWebContents(wc)?.close();
    await until(async () => !(await js(`[...document.querySelectorAll(${JSON.stringify(`${PERSONAL} .wizard-buttons .btn`)})].some((b) => b.disabled)`)), 5000);
    if ((await state()) !== 'key') no(`after the key without PRF the step shows "${await state()}"`);
    if ((await noticeText()).split(',').length !== 1) no(`key without PRF was stored: "${await noticeText()}"`);
  } catch (e) {
    no(`check without PRF failed: ${e.message}`);
  } finally {
    if (noPrf) await dbg.sendCommand('WebAuthn.removeVirtualAuthenticator', { authenticatorId: noPrf }).catch((e) => no(`authenticator without PRF not removed: ${e.message}`));
    await dbg.sendCommand('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: wc.kvAuthenticator, enabled: true }).catch((e) => no(`presence of the run's authenticator not restored: ${e.message}`));
  }
  return undefined;
}
