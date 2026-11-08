// #455: update channel of the browser extension. When the channel of the app changes, and for "Fix now" in the hint on the
// extension (#454), the browser policies of the extension are pointed to the feed of the channel: with UAC through
// desktop/machine-setup.js (#395: only reg.exe from the Windows folder runs elevated, with fixed values, no script from the
// installation folder). Policies of a company are never changed.

import { dialog } from 'electron';
import { t } from '../../extension/core/i18n.js';
import { canFix, readPolicies, runChannelSetup, windowsFolder } from '../machine-setup.js';
import { config, win } from './state.js';

/** Smoke only: { policies: { edge, chrome } of browserPolicy(), run({ channel, create }) → { result } } instead of the registry and the UAC call. */
let simulated = null;
export function simulateExtensionPolicy(sim) { simulated = sim; }

const currentChannel = () => (config.get().updateChannel === 'beta' ? 'beta' : 'stable');
const channelLabel = (channel) => (channel === 'beta' ? t('Early Access') : t('Stabil'));
const read = () => (simulated ? simulated.policies : readPolicies());
const supported = () => !!simulated || (process.platform === 'win32' && !!windowsFolder());
// #455: canFix also knows a browser the company manages elsewhere: there only our existing entries may be switched.
const fixable = (p, channel) => canFix(p.edge, 'edge', channel) || canFix(p.chrome, 'chrome', channel);
const runSetup = (options) => (simulated ? simulated.run(options) : runChannelSetup(undefined, undefined, options));

/** What the hint on the extension may offer: { available: a fix is possible, company: a company policy is in place }. */
export async function extensionFixState() {
  if (!supported()) return { available: false, company: false, channel: currentChannel() };
  const channel = currentChannel();
  const p = await read();
  const list = [p.edge, p.chrome];
  return { available: fixable(p, channel), company: list.some((x) => x.state === 'company' || x.managed), channel };
}

// The click on "Fix now" is the consent (#455, Lucas 08.11.): no dialog of our own before UAC, the hint shows the result.
const notice = (reason, message, detail) => (simulated || reason === 'fix' ? Promise.resolve() : dialog.showMessageBox(win, { type: 'info', buttons: [t('OK')], defaultId: 0, message, detail }));

/**
 * reason 'channel': the channel of the app was changed – only policies that Keevault set up are switched.
 * reason 'fix': "Fix now" – also creates the policy where there is none (unless the IT waived it or a foreign entry exists).
 * The click is the consent: no dialog before UAC and no notice, the hint in the window shows the result.
 * Result: { result }, one of unavailable, company, none, aligned, declined, changed (with company: true if a company
 * policy was left alone).
 */
export async function applyExtensionChannel({ reason }) {
  if (reason !== 'channel' && reason !== 'fix') throw new Error('unknown reason');
  if (!supported()) return { result: 'unavailable' };
  const channel = currentChannel();
  const p = await read();
  const list = [p.edge, p.chrome];
  if (!list.some((x) => x.state !== 'company')) {
    await notice(reason, t('Die Richtlinie für die Keevault-Erweiterung legt auf diesem Gerät deine Firma fest.'), t('Keevault ändert sie nicht. Wende dich an deine IT, wenn die Erweiterung nicht zur App passt.'));
    return { result: 'company' };
  }
  if (reason === 'channel' && !list.some((x) => x.state === 'ours')) {
    await notice(reason, t('Die Browser-Erweiterung folgt auf diesem Gerät ihrer eigenen Update-Quelle.'), t('Keevault hat dafür keine Richtlinie eingerichtet und ändert deshalb nichts. Unter „Einrichtung dieses Geräts“ kannst du sie einrichten.'));
    return { result: 'none' };
  }
  if (!fixable(p, channel)) return { result: 'aligned' };
  if (!simulated && reason === 'channel') {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [t('Umstellen (Administrator)'), t('Abbrechen')],
      defaultId: 0,
      cancelId: 1,
      message: t('Browser-Erweiterung auf „{channel}“ umstellen?', { channel: channelLabel(channel) }),
      detail: t('Keevault stellt die Update-Quelle der Erweiterung in Edge und Chrome um (Richtlinien auf diesem Gerät). Windows fragt dafür nach Administratorrechten. Danach den Browser einmal neu starten. Richtlinien deiner Firma ändert Keevault nie.'),
    });
    if (r.response !== 0) return { result: 'declined' };
  }
  const r = await runSetup({ channel, create: reason === 'fix' });
  if (r.result === 'declined') return { result: 'declined' }; // UAC declined: nothing changed
  if (r.result === 'unavailable' || r.result === 'failed') {
    throw new Error(t('Die Einrichtung wurde nicht abgeschlossen. Bitte eure IT bitten, das Intune-Skript „Keevault-Geraet-Einrichten.ps1“ auszuführen.'));
  }
  return { result: r.result, company: !!r.company };
}
