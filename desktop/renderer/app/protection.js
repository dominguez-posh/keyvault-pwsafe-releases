// Extra protection of a vault as the shared dialogs (extension/core/ui-protect.js) need it.

import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { st } from './state.js';

const owner = () => st?.account?.name || t('Ich');

/** The name left at its default: the main process names the passkey by what was registered (#531). */
const isDefault = (label) => !label || label === protectCtx.defaultLabel;

export const protectCtx = {
  info: (id) => call('protectionInfo', id),
  unlock: (id, params) => call('unlockContainer', id, params),
  unlockPasskey: (id) => call('unlockContainerPasskey', id),
  enable: (id, m) => call('enableProtection', id, m.passkeyLabel && isDefault(m.passkeyLabel) ? { ...m, passkeyLabel: null, passkeyOwner: owner() } : m),
  update: (id, op) => call('updateProtection', id, op),
  addPasskey: (id, label) => call('addContainerPasskey', id, isDefault(label) ? null : label, isDefault(label) ? { owner: owner() } : {}),
  /** #531: the FIDO step of the personal vault registers a security key, not Windows Hello. */
  addSecurityKey: (id) => call('addContainerPasskey', id, null, { owner: owner(), attachment: 'cross-platform', hints: ['security-key'] }),
  disable: (id) => call('disableProtection', id),
  lock: (id) => call('lockContainer', id),
  get passkeyAvailable() {
    return !!st?.passkeyAvailable;
  },
  get clientName() {
    return t('Windows');
  },
  get defaultLabel() {
    return `${owner()} – ${t('Desktop-App')}`;
  },
};
