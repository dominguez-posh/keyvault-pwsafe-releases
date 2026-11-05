// Drawing the window as a whole and loading its data: render, reload, refresh.

import { h, toast } from '../../../extension/core/dom.js';
import { setLanguage, t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { panes, root, setupSplitters, topActions, topSearch } from './layout.js';
import { items, setItems, setSt, st } from './state.js';
import { pinDialog } from './admin-mode.js';
import { loadAgentTrust } from './agents.js';
import { renderDetail } from './detail.js';
import { expiryReminded, expiryReminder, setExpiryReminded } from './health.js';
import { loadLogos } from './icons.js';
import { openItemLink, pendingItemLink } from './item-links.js';
import { renderList } from './list.js';
import { applyViewClass } from './main-menu.js';
import { firstStartWizards } from './personal.js';
import { checkWindowsRequests } from './requests.js';
import { renderSidebar } from './sidebar.js';
import { renderLocked, renderSetup } from './start.js';
import { checkOtherInstallation, updateDialog } from './updates.js';

export async function render() {
  setSt(await fetchState());
  setLanguage(st.settings.language);
  document.title = 'Keevault';
  document.body.dataset.ready = '1';
  // Installed version, always at the bottom right (the detail pane keeps room below its content, see desktop.css).
  let versionTag = document.getElementById('app-version');
  if (!versionTag) document.body.append(versionTag = h('button', { id: 'app-version', type: 'button', onclick: () => updateDialog() }));
  applyViewClass();
  versionTag.textContent = `Keevault ${st.version}`;
  versionTag.title = t('Nach Updates suchen …');
  const firstRun = !st.hasFiles && !st.settings.entraUsed && !st.settings.enforced.includes('tenantId') && !st.settings.policyContainers.length;
  if (!st.opened && firstRun && !st.settings.setupOffered && !st.smoke && !st.demo) {
    // First start on this device, nothing set up yet: straight into the app (nothing to unlock), the wizards follow.
    try {
      await call('unlock', { entra: false });
      return render();
    } catch {
      return renderSetup();
    }
  }
  if (!st.opened) return firstRun ? renderSetup() : renderLocked();
  await loadItems();
  // Admin mode shows itself in the brand ("Keevault for Admins") and the copper accent – no extra badge.
  const shell = h('div', { class: 'shell' }, panes.sidebar, panes.list, panes.detail, topSearch, topActions);
  root.replaceChildren(shell);
  setupSplitters(shell);
  renderSidebar();
  renderList();
  checkWindowsRequests();
  loadLogos();
  if (st.requirePin && !st.pinSet && !document.querySelector('dialog[open]')) pinDialog({ forced: true });
  // First start on this device with nothing set up: the personal vault wizard, then the setup wizard for a team vault
  // (skipped when the personal vault brought the vaults along from another device). Each opens only once.
  // The desktop demo (fresh profile each start) shows the same first start, with example resources and its own PIN.
  else if ((st.demo ? st.platform !== 'web' : !st.containers.length) && !st.settings.setupOffered && !document.querySelector('dialog[open]') && !st.smoke) {
    call('updateSettings', { personalOffered: true, setupOffered: true }).catch(() => {});
    setTimeout(() => firstStartWizards({ always: st.demo }), 400);
  } else if (!document.querySelector('dialog[open]') && !st.smoke && !st.demo) checkOtherInstallation();
  await renderDetail();
  if (pendingItemLink) openItemLink(pendingItemLink);
}

async function loadItems() {
  setItems(await call('items'));
  await loadAgentTrust();
}

// Settings changed here (admin mode, view) count up: a state fetched before such a change keeps the newer settings –
// otherwise a reload that was under way switched the admin mode back in the window while it stayed on.
export let settingsRev = 0;
export async function fetchState() {
  const rev = settingsRev;
  const fresh = await call('state');
  return rev === settingsRev || !st ? fresh : { ...fresh, settings: st.settings };
}

export async function reloadAll() {
  setSt(await fetchState());
  if (!st.opened) {
    setExpiryReminded(false);
    return render();
  }
  await loadItems();
  expiryReminder();
  if (!root.querySelector('.shell')) return render();
  renderSidebar();
  renderList();
  loadLogos();
  await renderDetail();
  if (pendingItemLink) openItemLink(pendingItemLink);
}

export async function refresh() {
  try {
    const r = await call('refresh');
    if (r.discoverError) toast(t('Tresor-Suche: {message}', { message: r.discoverError }), 'error');
    else toast(t('Aktualisiert'));
    await reloadAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// Other modules read these bindings directly and change them through the setters (imports are read-only).
export function setSettingsRev(value) { settingsRev = value; return value; }
