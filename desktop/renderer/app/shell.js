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
import { firstStartDue, offerFirstStart, remindPendingRecovery, resetRecoveryReminder } from './personal.js';
import { askSettingsCopy } from './settings-file.js';
import { checkWindowsRequests } from './requests.js';
import { startExtensionHint } from './ext-hint.js';
import { renderSidebar } from './sidebar.js';
import { renderLocked, renderSetup } from './start.js';
import { checkOtherInstallation, updateDialog } from './updates.js';

// Installed version, always at the bottom right (the detail pane keeps room below its content, see desktop.css).
// The update channel comes from the effective setting (policy included), never from a stamp in the build: the same
// pre-release becomes Prod later. Drawn by render (after saving the settings) and by reloadAll (a change that comes
// from elsewhere: policy, settings synced from another device).
function drawVersionTag() {
  let versionTag = document.getElementById('app-version');
  if (!versionTag) document.body.append(versionTag = h('button', { id: 'app-version', type: 'button', onclick: () => updateDialog() }));
  // #420: a Dev build shows "Dev Version", whatever the setting or a policy says (its stage is fixed in the build).
  const devStage = st.build?.dev === true;
  const beta = !devStage && st.settings.updateChannel === 'beta';
  versionTag.classList.toggle('early-access', beta);
  versionTag.classList.toggle('dev-stage', devStage);
  versionTag.dataset.channel = beta ? 'beta' : 'stable';
  const dev = st.build?.developer === true;
  versionTag.classList.toggle('developer', dev);
  versionTag.dataset.channel = dev ? 'developer' : devStage ? 'dev' : versionTag.dataset.channel;
  versionTag.replaceChildren(`Keevault ${st.version} · `, h('span', { class: 'ver-channel' }, dev ? `Developer${st.build.commit ? ` (${st.build.commit})` : ''}` : devStage ? 'Dev Version' : beta ? 'Early Access' : 'Stable'));
  versionTag.title = t('Nach Updates suchen …');
  startExtensionHint();
}

// #517: an environment variable on this PC switched TLS verification off or exposed TLS keys; the main process
// removed it at its start. Told once per window, without values; body[data-tls-env-warned] lets the smoke check see it.
let tlsEnvWarned = false;
function tlsEnvNotice() {
  if (tlsEnvWarned || !st?.tlsEnvWarning?.length) return;
  tlsEnvWarned = true;
  document.body.dataset.tlsEnvWarned = '1';
  toast(t('Eine Umgebungsvariable auf diesem PC schaltet die TLS-Prüfung ab oder legt TLS-Schlüssel offen ({names}). Keevault ignoriert sie. Lass sie entfernen – andere Programme sind weiter betroffen.', { names: st.tlsEnvWarning.join(', ') }), 'error');
}

export async function render() {
  setSt(await fetchState());
  setLanguage(st.settings.language);
  document.title = 'Keevault';
  document.body.dataset.ready = '1';
  applyViewClass();
  drawVersionTag();
  tlsEnvNotice();
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
  if (!st.opened) {
    resetRecoveryReminder();
    return firstRun ? renderSetup() : renderLocked();
  }
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
  else if (firstStartDue()) offerFirstStart();
  else if (!remindPendingRecovery() && !document.querySelector('dialog[open]')) {
    // #478: installations from before the update are asked once whether the settings may go to OneDrive as a copy.
    askSettingsCopy().then((asked) => { if (!asked && !st.smoke && !st.demo) checkOtherInstallation(); }).catch(() => {});
  }
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
  drawVersionTag();
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
  // The personal vault may have been unlocked just now (master password without a PIN binding).
  remindPendingRecovery();
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
