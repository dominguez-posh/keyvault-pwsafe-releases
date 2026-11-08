// API: admin tools – Microsoft sign-in in the browser, admin centers, connections to assets.

import { shell } from 'electron';
import { t } from '../../../extension/core/i18n.js';
import { bastionUrlInTenant } from '../../../extension/core/model.js';
import { smokeTest } from '../boot.js';
import { bridge, vault } from '../state.js';
import { deviceLinksHere, launchRdp, launchSsh, launchTeamViewer, serverAccount, splitEntryKey, usableItem } from '../devices.js';
import { requireOpen } from '../guards.js';
import { ADMIN_CENTER_HOSTS, MS_LOGIN_HOSTS, addSignInJob, adminCenterUrl, lastAdminUrl, setLastAdminUrl } from '../signin.js';

export const adminApi = {
  /**
   * Website of a login linked to a Microsoft login (external portal with "Sign in with Microsoft"): opened in the browser
   * without a one-click job: the foreign portal sends the tab on to Microsoft, which never counts as trusted, so the job
   * would wait two minutes for the next trusted tab (a mail link, #425). The Microsoft bar offers the accounts there.
   */
  async openWithMicrosoft({ containerId, id, url }) {
    requireOpen();
    if (!/^https?:\/\//i.test(url || '')) throw new Error(t('Keine gültige Adresse'));
    const item = await usableItem(containerId, id);
    if (!item.linked?.microsoft) throw new Error(t('Der Eintrag ist mit keinem Microsoft-Login verknüpft'));
    setLastAdminUrl(url);
    if (!smokeTest) await shell.openExternal(url);
    return { signIn: false };
  },
  /** Admin center in the browser; with an account the extension signs in with it (one-click, see signInFor). */
  async openAdminCenter({ url, key }) {
    requireOpen();
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      // not a URL
    }
    if (!ADMIN_CENTER_HOSTS.includes(host)) throw new Error(t('Unbekanntes Admin Center'));
    if (key) {
      addSignInJob(MS_LOGIN_HOSTS, String(key), 'microsoft');
      url = adminCenterUrl(url, (await vault.getItem(...splitEntryKey(String(key)))).username);
    }
    setLastAdminUrl(url);
    if (!smokeTest) await shell.openExternal(url);
    return { signIn: !!key && !!bridge?.clients?.size, url };
  },
  /** Connects to a server entry: RDP (mstsc with the account), TeamViewer, or Bastion in the browser. */
  async connectServer({ containerId, id, method }) {
    requireOpen();
    const item = await vault.getItem(containerId, id);
    if (item.type !== 'server') throw new Error(t('Kein Server-Eintrag'));
    const s = await deviceLinksHere(containerId, item);
    if (method === 'rdp') {
      if (!s.host) throw new Error(t('Kein Server (IP oder Name) hinterlegt'));
      const account = await serverAccount(item, s.rdpLink);
      return { method, ...(await launchRdp(s.host, s.port, account.username, account.password)) };
    }
    if (method === 'ssh') {
      if (!s.host) throw new Error(t('Kein Server (IP oder Name) hinterlegt'));
      const account = await serverAccount(item, s.rdpLink);
      return { method, ...(await launchSsh(s.host, s.port, account.username, account.password)) };
    }
    if (method === 'mgmt') {
      if (!/^https?:\/\//i.test(s.mgmtUrl)) throw new Error(t('Keine Verwaltungsseite hinterlegt'));
      if (!smokeTest) await shell.openExternal(s.mgmtUrl);
      return { method };
    }
    if (method === 'teamviewer') {
      if (!s.tvId) throw new Error(t('Keine TeamViewer-ID hinterlegt'));
      const password = s.tvLink ? (await serverAccount(item, s.tvLink)).password : s.tvPassword;
      return { method, ...(await launchTeamViewer(s.tvId, password)) };
    }
    if (method === 'bastion') {
      if (!/^https:\/\//i.test(s.bastionUrl)) throw new Error(t('Kein Bastion-Link hinterlegt'));
      if (s.bastionLoginLink) addSignInJob(MS_LOGIN_HOSTS, s.bastionLoginLink, 'microsoft');
      // The server account goes into Bastion's own sign-in form (portal blade or shareable link page).
      const vm = s.bastionVmLink || s.rdpLink || (item.username || item.password ? { username: item.username, password: item.password } : null);
      // 'bastion': fill Bastion's form and press its "Connect" (#31).
      if (vm) addSignInJob(['bastion.azure.com', 'reactblade.portal.azure.net', 'portal.azure.net'], vm, 'bastion');
      // In the VM's tenant (#30): the portal signs in to that directory, the Microsoft sign-in above picks the account.
      const url = bastionUrlInTenant(s.bastionUrl, s.bastionTenant);
      setLastAdminUrl(url);
      if (!smokeTest) await shell.openExternal(url);
      return { method, signIn: !!bridge?.clients?.size, url };
    }
    throw new Error(t('Unbekannte Verbindungsart'));
  },
};
