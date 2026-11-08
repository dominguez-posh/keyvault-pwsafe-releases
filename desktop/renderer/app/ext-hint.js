// #454: quiet hint next to the version tag when the browser extension is missing or does not fit; a click opens a
// popover with short steps and "Check again". #455: "Fix now" right in the hint where setup can fix it. Nothing is shown
// while everything is fine.

import { h, icon, toast } from '../../../extension/core/dom.js';
import { t, getLanguage } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { openUrl } from './helpers.js';
import { st } from './state.js';

const POLL_MS = 30_000;
let status = null;
let timer = null;

/** Title and steps by case (what the app knows for sure, see extensionStatus in desktop/versions.js). */
export function hintContent(s) {
  if (s.state === 'extensionOutdated') {
    return {
      label: t('Erweiterung aktualisieren'),
      title: t('Erweiterung aktualisieren'),
      facts: t('Gefunden: {found} · nötig: {need}', { found: s.extVersion || t('unbekannt'), need: s.minExtension }),
      steps: [t('Die Keevault-Erweiterung im Browser aktualisieren (Erweiterungsseite, „Aktualisieren“).'), t('Den Browser danach neu starten und hier „Erneut prüfen“ wählen.')],
      link: null,
    };
  }
  if (s.state === 'appOutdated') {
    return {
      label: t('App aktualisieren'),
      title: t('App aktualisieren'),
      facts: t('Die Erweiterung braucht Keevault {need} oder neuer, diese App ist {have}.', { need: s.minApp, have: s.appVersion }),
      steps: [t('Auf „Nach Updates suchen“ unten rechts klicken (Versionsanzeige) oder die neue Version von keevault.de laden.')],
      link: { label: t('Nach Updates suchen'), action: 'updates' },
    };
  }
  return {
    label: t('Keine Verbindung zur Browser-Erweiterung'),
    title: t('Keine Verbindung zur Browser-Erweiterung'),
    facts: t('Die App hört nichts von der Erweiterung. Mögliche Gründe: nicht installiert, Browser geschlossen oder die Einrichtung dieses Geräts fehlt.'),
    steps: [
      t('Browser öffnen und prüfen, ob die Keevault-Erweiterung installiert und eingeschaltet ist.'),
      t('Unter Einstellungen > Einrichtung dieses Geräts den Browser-Zugang einrichten.'),
      t('Hier „Erneut prüfen“ wählen.'),
    ],
    link: { label: t('Einstellungen öffnen'), action: 'settings' },
  };
}

function closePopover() {
  document.getElementById('ext-pop')?.remove();
  document.getElementById('ext-hint-open')?.setAttribute('aria-expanded', 'false');
}

async function recheck(button) {
  button.disabled = true;
  try {
    await refreshExtensionHint();
  } finally {
    button.disabled = false;
  }
  if (!status || status.state === 'ok') {
    closePopover();
    toast(t('Alles in Ordnung: Die Browser-Erweiterung ist verbunden.'));
  } else if (document.getElementById('ext-pop')) {
    openPopover();
  }
}

// #455: "Fix now" sits right in the hint, only where the browser policy can fix the cause (setup of this device, #395). One
// click is the consent: UAC follows at once, no dialog of our own. The result stays in a small notice above the hint until
// it is closed, so the advice to restart the browser does not vanish like a toast.
const fixable = () => !!status && (status.state === 'extensionOutdated' || status.state === 'noConnection');
let fix = null; // { available, company, channel } from the main process, or null
let fixing = false;
let result = null; // { kind: 'ok' | 'error', text }

function resultFor(r) {
  if (r.result === 'changed') return { kind: 'ok', text: t('Erledigt. Bitte Browser neu starten – falls die Erweiterung danach noch nicht erscheint, den PC neu starten.') };
  if (r.result === 'aligned') return { kind: 'ok', text: t('Die Einrichtung stimmt bereits. Bitte Browser neu starten – falls die Erweiterung danach noch nicht erscheint, den PC neu starten.') };
  if (r.result === 'declined') return { kind: 'error', text: t('Abgebrochen: Die Administratorabfrage wurde nicht bestätigt. Es wurde nichts geändert.') };
  if (r.result === 'company') return { kind: 'error', text: t('Nicht geändert: Die Richtlinie legt deine Firma fest – wende dich an deine IT.') };
  return { kind: 'error', text: t('Auf diesem Gerät kann Keevault die Einrichtung nicht selbst vornehmen.') };
}

async function applyFix() {
  if (fixing) return;
  fixing = true;
  closePopover();
  drawExtensionHint();
  try {
    result = resultFor(await call('extensionFix'));
  } catch (e) {
    result = { kind: 'error', text: t('Beheben fehlgeschlagen: {error}', { error: e.message }) };
  } finally {
    fixing = false;
  }
  await refreshExtensionHint();
  drawResult();
  document.getElementById('ext-result-close')?.focus();
}

function drawResult() {
  let box = document.getElementById('ext-result');
  if (!result || !st?.opened) {
    box?.remove();
    return;
  }
  if (!box) {
    box = h('div', { id: 'ext-result', role: 'status' });
    document.body.append(box);
  }
  box.className = result.kind;
  box.replaceChildren(
    icon(result.kind === 'ok' ? 'check' : 'info', 16),
    h('span', { class: 'text' }, result.text),
    h('button', { type: 'button', class: 'icon-btn', id: 'ext-result-close', 'aria-label': t('Hinweis schließen'), title: t('Hinweis schließen'), onclick: () => { result = null; drawResult(); } }, icon('x', 14)));
  const anchor = document.getElementById('ext-hint') || document.getElementById('app-version');
  const r = anchor?.getBoundingClientRect();
  box.style.setProperty('right', `${Math.max(8, r ? window.innerWidth - r.right : 8)}px`);
  box.style.setProperty('bottom', `${r ? window.innerHeight - r.top + 8 : 40}px`);
}

function openPopover() {
  closePopover();
  const anchor = document.getElementById('ext-hint');
  if (!anchor || !status || status.state === 'ok') return;
  const c = hintContent(status);
  const check = h('button', { type: 'button', class: 'btn small', id: 'ext-recheck', onclick: () => recheck(check) }, icon('refresh', 14), t('Erneut prüfen'));
  const actions = [check];
  if (c.link) {
    actions.push(h('button', { type: 'button', class: 'btn small', onclick: async () => {
      closePopover();
      if (c.link.action === 'settings') (await import('./settings.js')).settingsDialog();
      else (await import('./updates.js')).updateDialog();
    } }, c.link.label));
  }
  if (status.state === 'extensionOutdated' || status.state === 'noConnection') {
    actions.push(h('button', { type: 'button', class: 'btn small', onclick: () => openUrl('https://keevault.de/download.html') }, icon('external', 14), t('Download-Seite öffnen')));
  }
  // #455: the company manages the browser (also per user or in the cloud): Keevault creates nothing, the IT distributes the extension.
  if (fixable() && fix?.company) {
    const kb = getLanguage() === 'en' ? 'https://keevault.de/en/knowledge/intune.html' : 'https://keevault.de/wissen/it-verteilung.html';
    actions.push(h('button', { type: 'button', class: 'btn small', id: 'ext-it-kb', onclick: () => openUrl(kb) }, icon('external', 14), t('Verteilung durch die IT')));
  }
  const pop = h('div', { id: 'ext-pop', role: 'dialog', 'aria-label': c.title, onkeydown: (e) => { if (e.key === 'Escape') { closePopover(); anchor.focus(); } } },
    h('strong', {}, c.title),
    h('p', { class: 'muted small' }, c.facts),
    h('ol', {}, ...c.steps.map((x) => h('li', {}, x))),
    fixable() && fix?.available ? h('p', { class: 'muted small', id: 'ext-fix-note' }, t('Stellt die Browser-Richtlinie für Edge und Chrome auf den Update-Kanal „{channel}“. Windows fragt dafür nach Administratorrechten.', { channel: fix.channel === 'beta' ? t('Early Access') : t('Stabil') })) : null,
    fixable() && fix?.company ? h('p', { class: 'muted small', id: 'ext-it' }, t('Die Browser-Erweiterung verteilt auf diesem Gerät deine IT über eigene Richtlinien. Keevault legt deshalb keine Richtlinie an – wende dich an deine IT.')) : null,
    h('div', { class: 'actions' }, ...actions));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.setProperty('right', `${Math.max(8, window.innerWidth - r.right)}px`);
  pop.style.setProperty('bottom', `${window.innerHeight - r.top + 8}px`);
  document.getElementById('ext-hint-open')?.setAttribute('aria-expanded', 'true');
  check.focus();
}

/** Draws (or removes) the hint next to the version tag from the last known status. */
export function drawExtensionHint() {
  const versionTag = document.getElementById('app-version');
  let hint = document.getElementById('ext-hint');
  if (!versionTag || !status || status.state === 'ok' || !st?.opened) {
    hint?.remove();
    closePopover();
    return;
  }
  if (!hint) {
    hint = h('div', { id: 'ext-hint', role: 'group' });
    document.body.append(hint);
  }
  hint.dataset.state = status.state;
  const label = hintContent(status).label;
  hint.setAttribute('aria-label', label);
  const expanded = document.getElementById('ext-pop') ? 'true' : 'false';
  const open = h('button', { id: 'ext-hint-open', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': expanded, onclick: () => (document.getElementById('ext-pop') ? closePopover() : openPopover()) }, icon('info', 13), label);
  const fixButton = fixable() && fix?.available
    ? h('button', { id: 'ext-fix', type: 'button', disabled: fixing, title: t('Stellt die Browser-Richtlinie für Edge und Chrome auf den Update-Kanal „{channel}“. Windows fragt dafür nach Administratorrechten.', { channel: fix.channel === 'beta' ? t('Early Access') : t('Stabil') }), onclick: applyFix }, icon('shield', 12), t('Jetzt beheben'))
    : null;
  const focused = document.activeElement?.id;
  hint.replaceChildren(open, ...(fixButton ? [fixButton] : []));
  if (focused === 'ext-hint-open' || focused === 'ext-fix') document.getElementById(focused)?.focus();
  const r = versionTag.getBoundingClientRect();
  hint.style.setProperty('right', `${Math.max(8, window.innerWidth - r.left + 8)}px`);
  hint.style.setProperty('bottom', `${Math.max(0, window.innerHeight - r.bottom)}px`);
}

/** Asks the main process for the status again (and, where a fix may help, whether one is possible) and redraws. */
export async function refreshExtensionHint() {
  try {
    status = await call('extensionStatus');
  } catch {
    status = null;
  }
  if (fixable() && !fixing) {
    try {
      fix = await call('extensionFixState');
    } catch {
      fix = null;
    }
  } else if (!fixable()) fix = null;
  drawExtensionHint();
  drawResult();
}

/** Called after the version tag is drawn: draws the hint and starts the slow refresh once. */
export function startExtensionHint() {
  drawExtensionHint();
  refreshExtensionHint();
  if (!timer) {
    timer = setInterval(refreshExtensionHint, POLL_MS);
    window.addEventListener('resize', () => { drawExtensionHint(); drawResult(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.getElementById('ext-pop')) closePopover(); });
    document.addEventListener('click', (e) => { if (!e.target.closest?.('#ext-pop, #ext-hint')) closePopover(); });
  }
}
