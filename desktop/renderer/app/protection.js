// Extra protection of a vault as the shared dialogs (extension/core/ui-protect.js) need it.

import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { st } from './state.js';
import { withFreshPassword } from './master-password.js';
import { removeRecoveryStickDialog } from './mp-reset.js';
import { confirmEachSection } from './confirm-each.js';
import { withAccess } from './helpers.js';
import { compromisedOption } from './member-key.js';

const owner = () => st?.account?.name || t('Ich');

/** The name left at its default: the main process names the passkey by what was registered (#531). */
const isDefault = (label) => !label || label === protectCtx.defaultLabel;

export const protectCtx = {
  info: (id) => call('protectionInfo', id),
  unlock: (id, params) => withFreshPassword(() => call('unlockContainer', id, params)), // #537 (H2): adopting a personal vault
  unlockPasskey: (id) => call('unlockContainerPasskey', id),
  enable: (id, m) => call('enableProtection', id, m.passkeyLabel && isDefault(m.passkeyLabel) ? { ...m, passkeyLabel: null, passkeyOwner: owner() } : m),
  // #537: keys of the personal vault change only with a fresh master password – asked when the main process wants it.
  update: (id, op) => withFreshPassword(() => withAccess(() => call('updateProtection', id, op))), // #537 2b: withAccess
  addPasskey: (id, label) => withFreshPassword(() => withAccess(() => call('addContainerPasskey', id, isDefault(label) ? null : label, isDefault(label) ? { owner: owner() } : {}))),
  /** #531: the FIDO step of the personal vault registers a security key, not Windows Hello. */
  addSecurityKey: (id) => withFreshPassword(() => withAccess(() => call('addContainerPasskey', id, null, { owner: owner(), attachment: 'cross-platform', hints: ['security-key'] }))),
  /** #537 stage 6: a recovery stick (FIDO, PRF) for the personal vault – resets the master password. */
  addRecoveryStick: (id) => withFreshPassword(() => call('addRecoveryStick', id)),
  /** Konrad M1: a key change – asked with the master password, the new recovery key shown (desktop/renderer/app/mp-reset.js). */
  removeRecoveryStick: (id, stick) => removeRecoveryStickDialog(id, stick),
  /** #539: in the key change of the personal vault – "master password compromised": renew the memberships. */
  rekeyOption: (container) => (container.personal ? compromisedOption() : null),
  /** #537 2b: "Immer bestätigen" of the personal vault. */
  confirmEachSection: (container) => confirmEachSection(container),
  disable: (id) => withAccess(() => call('disableProtection', id)),
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
