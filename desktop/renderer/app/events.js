// Events from the main process (locked, changed, progress, updates …) and their effect on the window.

import { toast } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { healthDialog, accessReportDialog } from '../reports.js';
import * as progress from '../progress.js';
import { parseItemLink } from '../../../extension/core/links.js';
import { call } from './ipc.js';
import { panes } from './layout.js';
import { busyContainers, items, progressListeners, setItems, st, ui } from './state.js';
import { loadAgentTrust } from './agents.js';
import { reportCtx } from './health.js';
import { generatorDialog } from './item-actions.js';
import { openItemLink } from './item-links.js';
import { clearSelection } from './multi.js';
import { remindPendingRecovery } from './personal.js';
import { refreshExtensionHint } from './ext-hint.js';
import { checkWindowsRequests, flashPasskey, openQuestions, questionDialog } from './requests.js';
import { reloadAll, render } from './shell.js';
import { pinDialog } from './admin-mode.js';
import { updateDialog, updateListeners } from './updates.js';
import { addContainerDialog } from './vault-wizard.js';

let reloadTimer = null;

window.pwsafe.onEvent((ev) => {
  if (ev.type === 'locked') {
    Object.assign(ui, { selected: null, editing: null, editingItem: null });
    clearSelection();
    busyContainers.clear();
    setItems([]);
    // Dialogs hang on the body, the lock screen is drawn behind them: a recovery key or an entry would stay readable
    // (#399). Closing counts as "no" where it means something: an AI agent's question or a Windows request is refused.
    for (const d of document.querySelectorAll('dialog[open]')) if (!d.dataset.keepOnLock) d.dispatchEvent(new Event('cancel', { cancelable: true }));
    render();
  } else if (ev.type === 'changed' && st?.opened) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reloadAll().catch(() => {}), 250);
  } else if (ev.type === 'changed' && st && !st.opened) {
    // Unlocked elsewhere (tray, an agent's request, a test): show the vaults. Still locked: the screen stays as it is.
    call('state').then((s) => { if (s.opened) render(); }).catch(() => {});
  } else if (ev.type === 'sync-stopped' && st?.opened) {
    toast(t('{provider} läuft nicht – Änderungen an Tresoren in diesem Ordner werden nicht synchronisiert. Starte {provider}.', { provider: ev.provider }), 'error');
  } else if (ev.type === 'link') {
    const entry = parseItemLink(ev.url);
    if (entry) openItemLink(entry);
    else addContainerDialog(ev.url);
  } else if (ev.type === 'progress') {
    progress.onEvent(ev);
    for (const fn of progressListeners) fn(ev);
  } else if (ev.type === 'busy') {
    // A vault is being loaded or reconciled: its refresh icon spins (also set when the sidebar is re-rendered).
    if (ev.busy) busyContainers.add(ev.containerId);
    else busyContainers.delete(ev.containerId);
    for (const b of panes.sidebar.querySelectorAll('.nav-refresh')) b.classList.toggle('spinning', busyContainers.has(b.dataset.container));
  } else if (ev.type === 'windows-request') {
    checkWindowsRequests();
  } else if (ev.type === 'generator') {
    generatorDialog();
  } else if (ev.type === 'health') {
    if (st?.opened) healthDialog(reportCtx());
  } else if (ev.type === 'access') {
    if (st?.opened) accessReportDialog(reportCtx());
  } else if (ev.type === 'update') {
    progress.fromUpdate(ev.state);
    for (const fn of updateListeners) fn(ev.state);
  } else if (ev.type === 'question') {
    questionDialog(ev);
  } else if (ev.type === 'questionClose') {
    openQuestions.get(ev.id)?.();
  } else if (ev.type === 'mcpTrusted') {
    loadAgentTrust();
  } else if (ev.type === 'passkeyPinNeeded') {
    // #439: a passkey was asked for while no PIN is set – nothing is signed, the PIN is set first.
    if (st?.opened && !st.pinSet && !document.querySelector('dialog[open]')) pinDialog({ passkeys: true });
  } else if (ev.type === 'passkeyFlash') {
    flashPasskey(ev.text);
  } else if (ev.type === 'checkUpdates') {
    updateDialog();
  } else if (ev.type === 'updateOffer') {
    updateDialog(ev.state);
  } else if (ev.type === 'extensionChanged') {
    refreshExtensionHint();
  } else if (ev.type === 'extensionOutdated') {
    // An old extension cannot say this itself; only a hint, nothing else depends on it (#347).
    toast(t('Erweiterung aktualisieren: Die Browser-Erweiterung ist veraltet oder meldet ihre Version nicht (nötig ab 0.9.29). Alte Versionen können keine Passkeys verwenden und kopieren über die Zwischenablage des Browsers, nicht geschützt.'), 'error');
  }
});

window.addEventListener('kvpwsafe-refresh', () => reloadAll());
// Unlocked while the window was hidden (browser extension, tray): the question waits until someone can see it.
window.addEventListener('focus', () => { if (st?.opened) remindPendingRecovery(); });
