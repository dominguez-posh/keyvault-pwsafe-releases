// Protection context for extension pages (options, prompt window): passkey ceremonies run in the page with the
// extension ID as RP ID, everything else in the service worker.

import { evaluatePrf, registerPrf } from '../core/prf.js';
import { t } from '../core/i18n.js';
import { call } from './api.js';

const RP_ID = chrome.runtime.id;

export function protectCtx(account) {
  const label = `${account?.name || account?.username || t('Ich')} – ${t('Browser')}`;
  const register = async (containerId, name, exclude = []) => {
    const info = await call('protection:info', { containerId }).catch(() => ({ passkeys: [] }));
    const pk = await registerPrf(RP_ID, { userName: `${name} · Keevault`, displayName: name, excludeCredentialIds: [...exclude, ...info.passkeys.map((p) => p.credentialId)] });
    return { ...pk, label: name };
  };
  return {
    info: (id) => call('protection:info', { containerId: id }),
    unlock: (id, params) => call('protection:unlock', { containerId: id, params }),
    async unlockPasskey(id) {
      const info = await call('protection:info', { containerId: id });
      const r = await evaluatePrf(RP_ID, info.passkeys);
      return call('protection:unlock', { containerId: id, params: r });
    },
    async enable(id, { password, passkeyLabel }) {
      const passkey = passkeyLabel ? await register(id, passkeyLabel) : null;
      return call('protection:enable', { containerId: id, methods: { password, passkey } });
    },
    update: (id, op) => call('protection:update', { containerId: id, op }),
    async addPasskey(id, name) {
      const passkey = await register(id, name);
      return call('protection:update', { containerId: id, op: { type: 'addPasskey', passkey } });
    },
    disable: (id) => call('protection:disable', { containerId: id }),
    lock: (id) => call('protection:lock', { containerId: id }),
    passkeyAvailable: true,
    clientName: t('der Browser'),
    defaultLabel: label,
  };
}
