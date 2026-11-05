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
import { checkWindowsRequests, flashPasskey, openQuestions, questionDialog } from './requests.js';
import { reloadAll, render } from './shell.js';
import { updateDialog, updateListeners } from './updates.js';
import { addContainerDialog } from './vault-wizard.js';

let reloadTimer = null;

window.pwsafe.onEvent((ev) => {
  if (ev.type === 'locked') {
    Object.assign(ui, { selected: null, editing: null, editingItem: null });
    clearSelection();
    busyContainers.clear();
    setItems([]);
    render();
  } else if (ev.type === 'changed' && st?.opened) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reloadAll().catch(() => {}), 250);
  } else if (ev.type === 'changed' && st && !st.opened) {
    // Unlocked elsewhere (tray, an agent's request, a test): show the vaults. Still locked: the screen stays as it is.
    call('state').then((s) => { if (s.opened) render(); }).catch(() => {});
  } else if (ev.type === 'rdp-type-failed') {
    toast(t('Der Windows-Anmeldedialog kam nicht nach vorne – das Passwort liegt in der Zwischenablage, dort mit Strg+V einfügen.'), 'error');
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
  } else if (ev.type === 'passkeyFlash') {
    flashPasskey(ev.text);
  } else if (ev.type === 'checkUpdates') {
    updateDialog();
  } else if (ev.type === 'updateOffer') {
    updateDialog(ev.state);
  }
});

window.addEventListener('kvpwsafe-refresh', () => reloadAll());
