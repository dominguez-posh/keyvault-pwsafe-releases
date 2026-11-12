// API: Windows Hello for the window lock (#512) – status, switching it on (with the app PIN) and off, unlocking.

import { t } from '../../../extension/core/i18n.js';
import { config } from '../state.js';
import { pinGuard, requireOpen } from '../guards.js';
import { helloAvailable, unlockWindowWithHello, windowHelloOn } from '../window-hello.js';
import { diag } from '../diag.js';
import { api } from './index.js';

export const windowHelloApi = {
  /** For the settings: switched on, and whether Windows Hello is set up on this device. */
  async helloStatus() {
    requireOpen();
    return { on: windowHelloOn(), available: await helloAvailable() };
  },
  /** On only with the app PIN (counted like every PIN attempt); off at any time. → state */
  async setWindowHello({ on = false, pin = '' } = {}) {
    requireOpen();
    if (!on) {
      config.update({ windowHello: false });
      diag('HELLO window unlock off');
      return api.state();
    }
    if (config.get().enforced.includes('windowHello')) throw new Error(t('Eure Organisation hat das Entsperren mit Windows Hello abgeschaltet'));
    if (!config.get().appPin) throw new Error(t('Für Windows Hello brauchst du eine App-PIN – lege sie zuerst fest.'));
    await api.verifyPin(String(pin || ''));
    pinGuard.consume(); // the PIN switched a setting on – it opens nothing afterwards
    if (!(await helloAvailable())) throw new Error(t('Windows Hello ist auf diesem Gerät nicht eingerichtet'));
    config.update({ windowHello: true });
    diag('HELLO window unlock on');
    return api.state();
  },
  /** The window's lock screen: Windows Hello instead of the PIN – checked here, never reported by the window. */
  async unlockWithHello() {
    await unlockWindowWithHello();
    return api.state();
  },
};
