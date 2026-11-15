// The admin centers of a Microsoft entry (PIM and the centers' tiles). Data only, so it is unit-tested.

import { t } from '../../../extension/core/i18n.js';

// PIM "My roles" (activate eligible Entra roles) – the page aka.ms/pim leads to, opened directly so the sign-in can be
// handed to the browser extension (only admin center hosts are allowed, see main.js). SharePoint goes through the M365
// admin center, which knows the tenant.
// Shown as a panel in the entry: PIM on top, the rest grouped. Each center has its own symbol (dom.js "ac-…") drawn
// after its job, in Keevault's blue; PIM in its own violet (--pim). No vendor logos or logo colours (#538, DESIGN.md).
export const ADMIN_LINKS = [
  { id: 'pim', name: 'PIM', url: 'https://portal.azure.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadmigratedroles', icon: 'ac-elevate', title: t('Rolle mit Privileged Identity Management aktivieren') },
  { id: 'entra', name: 'Entra ID', url: 'https://entra.microsoft.com', icon: 'ac-id', group: 'identity', host: 'entra.microsoft.com' },
  { id: 'defender', name: 'Defender', url: 'https://security.microsoft.com', icon: 'ac-radar', group: 'identity', host: 'security.microsoft.com' },
  { id: 'purview', name: 'Purview', url: 'https://purview.microsoft.com', icon: 'ac-compliance', group: 'identity', host: 'purview.microsoft.com' },
  { id: 'm365', name: 'Microsoft 365', url: 'https://admin.microsoft.com', icon: 'ac-admin', group: 'm365', host: 'admin.microsoft.com' },
  { id: 'exchange', name: 'Exchange', url: 'https://admin.exchange.microsoft.com', icon: 'ac-mailbox', group: 'm365', host: 'admin.exchange.microsoft.com' },
  { id: 'teams', name: 'Teams', url: 'https://admin.teams.microsoft.com', icon: 'ac-chat', group: 'm365', host: 'admin.teams.microsoft.com' },
  { id: 'sharepoint', name: 'SharePoint', url: 'https://admin.microsoft.com/sharepoint', icon: 'ac-sites', group: 'm365', host: 'SharePoint Admin Center' },
  { id: 'intune', name: 'Intune', url: 'https://intune.microsoft.com', icon: 'ac-devices', group: 'm365', host: 'intune.microsoft.com' },
  { id: 'azure', name: 'Azure Portal', url: 'https://portal.azure.com', icon: 'ac-cloud', group: 'azure', host: 'portal.azure.com' },
];
