// The main menu (☰) with the view settings: zoom, density, what the sidebar shows.

import { h, icon, iconButton, toast } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { expiringEntries } from '../../../extension/core/health.js';
import { healthDialog, accessReportDialog } from '../reports.js';
import { call } from './ipc.js';
import { items, st } from './state.js';
import { openUrl } from './helpers.js';
import { adminModeDialog, setAdminMode } from './admin-mode.js';
import { ADMIN_LINKS } from './admin-tools.js';
import { reportCtx } from './health.js';
import { generatorDialog } from './item-actions.js';
import { adminMode } from './modes.js';
import { settingsDialog } from './settings.js';
import { refresh, render, setSettingsRev, settingsRev } from './shell.js';
import { renderSidebar } from './sidebar.js';
import { openTrash } from './trash.js';

/** See-through ground (light/strong) as classes on <html>; the main process switches the window material. */
export function applyViewClass() {
  const mode = st?.settings?.transparency || 'light';
  document.documentElement.classList.toggle('see-through', mode === 'light' || mode === 'strong');
  document.documentElement.classList.toggle('see-through-strong', mode === 'strong');
  document.documentElement.classList.toggle('show-admin', st?.settings?.adminTools === true);
  // Admin mode in the copper/red of the admin palette – only the colour changes, never the layout.
  document.documentElement.classList.toggle('admin-theme', st?.settings?.adminTools === true);
}

const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
const zoomNow = () => Number(st?.settings?.zoom) || 1;

/** Zoom one step in (+1), out (-1) or back to 100 % (0); remembered in the settings. */
export async function stepZoom(dir) {
  const now = zoomNow();
  let next = 1;
  if (dir > 0) next = ZOOM_STEPS.find((z) => z > now + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  if (dir < 0) next = [...ZOOM_STEPS].reverse().find((z) => z < now - 0.001) ?? ZOOM_STEPS[0];
  await setView({ zoom: next });
  toast(t('Zoom {n} %', { n: Math.round(next * 100) }));
}

async function setView(patch) {
  setSettingsRev(settingsRev + 1);
  st.settings = await call('updateSettings', patch);
  setSettingsRev(settingsRev + 1);
  applyViewClass();
  document.querySelectorAll('[data-view-value]').forEach((el) => el.dispatchEvent(new Event('view-changed')));
}

function viewRow(label, control) {
  return h('div', { class: 'view-row' }, h('span', { class: 'grow' }, label), control);
}

function zoomControl() {
  const value = h('span', { class: 'zoom-value', 'data-view-value': '' });
  const show = () => { value.textContent = `${Math.round(zoomNow() * 100)} %`; };
  value.addEventListener('view-changed', show);
  show();
  const step = (dir, label, text) => h('button', { type: 'button', class: 'view-step', 'aria-label': label, title: label, onclick: () => stepZoom(dir) }, text);
  return h('span', { class: 'zoom-control' }, step(-1, t('Verkleinern (Strg −)'), '−'),
    h('button', { type: 'button', class: 'view-reset', title: t('Auf 100 % (Strg 0)'), onclick: () => stepZoom(0) }, value),
    step(1, t('Vergrößern (Strg +)'), '+'));
}

/** View: an on/off switch for a setting (`on` = its default when unset), `after` redraws what it affects. */
function onOffControl(key, label, on, after) {
  const box = h('span', { class: 'seg', role: 'radiogroup', 'aria-label': label, 'data-view-value': '' });
  const draw = () => box.replaceChildren(...[[true, t('An')], [false, t('Aus')]].map(([value, text]) => {
    const current = (st.settings[key] ?? on) === value;
    return h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(current), class: current ? 'on' : '',
      onclick: async () => { await setView({ [key]: value }); after?.(); },
    }, text);
  }));
  box.addEventListener('view-changed', draw);
  draw();
  return box;
}

/** View → "Ansicht auf Standard": zoom, transparency, bottom bar, source marks and column widths as on first start. */
async function resetView() {
  try { localStorage.removeItem('paneWidths'); } catch {}
  await setView({ zoom: 1, theme: 'system', transparency: 'light', sourceBadges: true, pimButton: false, pimOnLock: false, adminPim: false, adminTools: false });
  await render();
  toast(t('Ansicht zurückgesetzt'));
}

/** View: a segmented choice for a setting – `choices` as [value, label], `fallback` when unset. */
function choiceControl(key, label, choices, fallback) {
  const box = h('span', { class: 'seg', role: 'radiogroup', 'aria-label': label, 'data-view-value': '' });
  const draw = () => box.replaceChildren(...choices.map(([value, text]) => {
    const current = (st.settings[key] || fallback) === value;
    return h('button', { type: 'button', role: 'radio', 'aria-checked': String(current), class: current ? 'on' : '', onclick: () => setView({ [key]: value }) }, text);
  }));
  box.addEventListener('view-changed', draw);
  draw();
  return box;
}

/** Empty detail pane: the Keevault mark as a quiet outline – shield with the keyhole, like a shadow of the logo. */
export function placeholderMark() {
  const mark = h('span', { class: 'placeholder-mark', 'aria-hidden': 'true' });
  mark.innerHTML = '<svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">'
    + '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'
    + '<path d="M12 8.3a2 2 0 0 1 1.15 3.64l.6 3.56h-3.5l.6-3.56A2 2 0 0 1 12 8.3z" fill="currentColor" stroke="none"/></svg>';
  return mark;
}

/** Sidebar foot, next to Help: admin mode as a switch – on asks for the app PIN, off ends it at once. */
export function adminFootButton() {
  const on = adminMode();
  return h('button', { type: 'button', role: 'switch', 'aria-checked': String(on), class: `admin-switch admin-foot ${on ? 'on' : ''}`,
    title: on ? t('Admin-Modus beenden') : t('Admin-Modus aktivieren …'), dataset: { action: on ? 'admin-off' : 'admin-on' },
    onclick: () => (on ? setAdminMode(false) : adminModeDialog()) },
  h('span', { class: 'switch', 'aria-hidden': 'true' }, h('span', { class: 'switch-knob' })), t('Admin'));
}

/** Admin mode: PIM in the sidebar head (Settings → View → "PIM button in admin mode"). */
export function pimHeadButton() {
  const b = iconButton('ac-elevate', t('PIM: Rolle aktivieren'), () => openUrl(ADMIN_LINKS[0].url));
  b.classList.add('pim-head');
  return b;
}

/** Settings → View: every view setting (the menu keeps only design and zoom); changes apply at once. */
export function viewSettings() {
  return [
    viewRow(t('Zoom'), zoomControl()),
    viewRow(t('Design'), choiceControl('theme', t('Design'), [['system', t('System')], ['light', t('Hell')], ['dark', t('Dunkel')]], 'system')),
    viewRow(t('Transparenz'), choiceControl('transparency', t('Transparenz'), [['off', t('Aus')], ['light', t('Leicht')], ['strong', t('Stark')]], 'light')),
    viewRow(t('Speicherort'), onOffControl('sourceBadges', t('Speicherort'), true, renderSidebar)),
    viewRow(t('PIM beim Entsperren'), onOffControl('pimOnLock', t('PIM beim Entsperren'), false)),
    viewRow(t('Admin-Modus anbieten'), onOffControl('adminOffered', t('Admin-Modus anbieten'), false, renderSidebar)),
    viewRow(t('PIM-Knopf im Admin-Modus'), onOffControl('adminPim', t('PIM-Knopf im Admin-Modus'), false, renderSidebar)),
    h('p', { class: 'muted small' }, t('Änderungen gelten sofort. „Admin-Modus anbieten“ zeigt unten neben „Hilfe“ einen Schalter für den Admin-Modus (Einschalten mit der App-PIN). Der PIM-Knopf erscheint im Admin-Modus oben links zwischen „Keevault for Admins“ und dem Schloss.')),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn small', dataset: { action: 'view-reset' }, onclick: resetView }, icon('refresh', 14), t('Auf Standard zurücksetzen'))),
  ];
}

/** Burger next to the logo: opens the main menu; a dot when the password check reports expiring entries. */
export function mainMenuButton() {
  const b = iconButton('menu', t('Menü'), (e) => mainMenu(e.currentTarget));
  b.classList.add('menu-btn');
  b.setAttribute('aria-haspopup', 'menu');
  if (expiringEntries(items).length) b.append(h('span', { class: 'menu-dot', 'aria-hidden': 'true' }));
  return b;
}

/** Main menu (account, reload, settings, tools, lock) as a card under the burger. */
function mainMenu(anchor) {
  const existing = document.querySelector('.main-menu');
  if (existing) {
    existing.remove();
    return;
  }
  const name = st.account?.name || st.account?.username || t('Lokal');
  const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('') || 'K';
  const expiring = expiringEntries(items).length;
  const entry = (action, iconName, label, onClick, extra = null) => h('button', { type: 'button', role: 'menuitem', dataset: { action }, onclick: () => {
    close();
    onClick();
  } }, icon(iconName, 16), h('span', { class: 'grow' }, label), extra);
  // One menu (#18): the most used view settings on top, then actions and tools. Every view setting is under
  // Settings → View; admin mode is offered there and then sits next to Help (#23).
  const menu = h('div', { class: 'main-menu', role: 'menu', 'aria-label': t('Menü') },
    h('div', { class: 'main-menu-account' },
      h('span', { class: 'main-menu-avatar' }, initials),
      h('span', { class: 'main-menu-who' }, h('b', {}, name), h('span', {}, st.account?.username || t('Nur Datei-Tresore')))),
    h('div', { class: 'main-menu-pane view-pane', role: 'group', 'aria-label': t('Ansicht') },
      viewRow(t('Design'), choiceControl('theme', t('Design'), [['system', t('System')], ['light', t('Hell')], ['dark', t('Dunkel')]], 'system')),
      viewRow(t('Zoom'), zoomControl())),
    h('div', { class: 'context-sep' }),
    h('div', { class: 'main-menu-pane', role: 'group', 'aria-label': t('Menü') },
      entry('settings', 'settings', t('Einstellungen'), settingsDialog),
      entry('reload', 'refresh', t('Neu laden'), refresh),
      h('div', { class: 'main-menu-label' }, t('Werkzeuge')),
      entry('generator', 'key', t('Passwort-Generator'), generatorDialog),
      entry('health', 'shield', t('Passwort-Check'), () => healthDialog(reportCtx()), expiring ? h('span', { class: 'count warn', title: t('Einträge laufen ab') }, expiring) : null),
      st.signedIn ? entry('access', 'users', t('Zugriffsbericht'), () => accessReportDialog(reportCtx())) : null,
      entry('trash', 'trash', t('Papierkorb'), openTrash),
      st.releaseSigning ? entry('release-sign', 'key', t('Release signieren'), () => call('signRelease').catch((e) => toast(e.message, 'error'))) : null,
      st.releaseSigning ? entry('release-setup', 'key', t('Release-Schlüssel einrichten'), () => call('setupReleaseKey').catch((e) => toast(e.message, 'error'))) : null,
      st.releaseSigning ? entry('release-approvers', 'key', t('Release-Freigeber anzeigen'), () => call('showReleaseApprovers').catch((e) => toast(e.message, 'error'))) : null,
      h('div', { class: 'context-sep' }),
      entry('lock', 'lock', t('Sperren'), () => call('lock'))));
  const close = () => {
    menu.classList.add('closing');
    setTimeout(() => menu.remove(), 120);
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
  };
  const outside = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      anchor.focus();
    }
  };
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 8}px`;
  // Small window: the menu ends 10 px above the bottom edge and scrolls instead of being cut off.
  menu.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 18)}px`;
  menu.style.left = `${Math.max(10, r.right - menu.offsetWidth)}px`;
  window.addEventListener('mousedown', outside, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  menu.querySelector('button')?.focus();
}
