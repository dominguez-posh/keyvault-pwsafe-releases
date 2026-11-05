// Extra protection of a vault as the shared dialogs (extension/core/ui-protect.js) need it.

import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { st } from './state.js';

export const protectCtx = {
  info: (id) => call('protectionInfo', id),
  unlock: (id, params) => call('unlockContainer', id, params),
  unlockPasskey: (id) => call('unlockContainerPasskey', id),
  enable: (id, m) => call('enableProtection', id, m),
  update: (id, op) => call('updateProtection', id, op),
  addPasskey: (id, label) => call('addContainerPasskey', id, label),
  disable: (id) => call('disableProtection', id),
  lock: (id) => call('lockContainer', id),
  get passkeyAvailable() {
    return !!st?.passkeyAvailable;
  },
  get clientName() {
    return t('Windows');
  },
  get defaultLabel() {
    return `${st?.account?.name || t('Ich')} – ${t('Desktop-App')}`;
  },
};
