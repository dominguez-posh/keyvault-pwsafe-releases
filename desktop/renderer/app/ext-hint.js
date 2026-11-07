// #454: quiet hint next to the version tag when the browser extension is missing or does not fit; a click opens a
// popover with short steps and "Check again". Nothing is shown while everything is fine.

import { h, icon, toast } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
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
  document.getElementById('ext-hint')?.setAttribute('aria-expanded', 'false');
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
  const pop = h('div', { id: 'ext-pop', role: 'dialog', 'aria-label': c.title, onkeydown: (e) => { if (e.key === 'Escape') { closePopover(); anchor.focus(); } } },
    h('strong', {}, c.title),
    h('p', { class: 'muted small' }, c.facts),
    h('ol', {}, ...c.steps.map((x) => h('li', {}, x))),
    h('div', { class: 'actions' }, ...actions));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.setProperty('right', `${Math.max(8, window.innerWidth - r.right)}px`);
  pop.style.setProperty('bottom', `${window.innerHeight - r.top + 8}px`);
  anchor.setAttribute('aria-expanded', 'true');
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
    hint = h('button', { id: 'ext-hint', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => (document.getElementById('ext-pop') ? closePopover() : openPopover()) });
    document.body.append(hint);
  }
  hint.dataset.state = status.state;
  hint.replaceChildren(icon('info', 12), hintContent(status).label);
  const r = versionTag.getBoundingClientRect();
  hint.style.setProperty('right', `${Math.max(8, window.innerWidth - r.left + 8)}px`);
  hint.style.setProperty('bottom', `${Math.max(0, window.innerHeight - r.bottom)}px`);
}

/** Asks the main process for the status again and redraws; also re-opens nothing by itself. */
export async function refreshExtensionHint() {
  try {
    status = await call('extensionStatus');
  } catch {
    status = null;
  }
  drawExtensionHint();
}

/** Called after the version tag is drawn: draws the hint and starts the slow refresh once. */
export function startExtensionHint() {
  drawExtensionHint();
  refreshExtensionHint();
  if (!timer) {
    timer = setInterval(refreshExtensionHint, POLL_MS);
    window.addEventListener('resize', drawExtensionHint);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.getElementById('ext-pop')) closePopover(); });
    document.addEventListener('click', (e) => { if (!e.target.closest?.('#ext-pop, #ext-hint')) closePopover(); });
  }
}
