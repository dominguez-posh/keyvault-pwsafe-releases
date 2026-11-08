// Azure (ARM and Graph) errors for the user interface: the raw text carries subscription IDs, resource groups,
// object IDs and UPNs, so it never goes on screen. The UI gets a neutral text; the raw text goes only into the
// diagnostics log, with the subscription ID masked.
import { t } from './i18n.js';

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Is this a "not allowed" answer from Azure (HTTP 403 or an authorization error code)? */
export function isAzureForbidden(e) {
  return e?.name === 'AzureError'
    && (e.status === 403 || /^(AuthorizationFailed|LinkedAuthorizationFailed|Authorization_RequestDenied)$/i.test(e.code || ''));
}

/** For the diagnostics log: subscription ID masked (also inside resource paths and standalone as GUID). */
export function maskForLog(text) {
  return String(text ?? '')
    .replace(/(\/subscriptions\/)[^/\s"']+/gi, '$1********')
    .replace(/(subscription[^0-9a-f]{0,12})[0-9a-f]{8}-[0-9a-f-]{27}/gi, '$1********');
}

/**
 * Text for the UI. Azure errors: authorization errors become a fixed neutral sentence; other Azure errors keep
 * their sentence but lose resource paths, GUIDs and mail addresses. Everything else passes unchanged.
 */
export function uiMessage(e) {
  if (e?.name !== 'AzureError') return e?.message ?? String(e);
  if (isAzureForbidden(e)) return t('Dafür fehlt dir die Berechtigung in Azure.');
  return String(e.message || '')
    .replace(/\/subscriptions\/\S*/gi, t('(Azure-Ressource)'))
    .replace(GUID, '…')
    .replace(/[^\s"'<>()]+@[^\s"'<>()]+/g, '…');
}
