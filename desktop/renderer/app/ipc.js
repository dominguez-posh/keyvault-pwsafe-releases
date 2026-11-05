// Calls into the main process (window.pwsafe.invoke) with the progress card for slow ones.

import { t } from '../../../extension/core/i18n.js';
import * as progress from '../progress.js';

// Calls that can take a moment show the progress card bottom right (progress.js); the main process reports
// done/total under the same id where it knows them. Dialogs with their own inline progress are not listed.
const SLOW_CALLS = { unlock: 'Entsperren …', refresh: 'Aktualisieren …', healthReport: 'Passwort-Check …', accessReport: 'Zugriffsbericht …', vaultInfo: 'Tresor-Infos werden geladen …', checkForUpdates: 'Suche nach Updates …' };

export async function call(method, ...args) {
  const end = SLOW_CALLS[method] ? progress.begin(method, t(SLOW_CALLS[method])) : null;
  try {
    const r = await window.pwsafe.invoke(method, args);
    if (!r.ok) {
      const e = new Error(r.error.message);
      e.name = r.error.name;
      e.status = r.error.status;
      throw e;
    }
    return r.result;
  } finally {
    end?.();
  }
}
