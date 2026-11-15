// #537: the one master password of the app on this device – desktop/unlock-service.js wired to the settings, DPAPI
// (safeStorage), the personal vault and the offline mirror. Everything else imports the functions below.

import { safeStorage } from 'electron';
import { UnlockService } from '../unlock-service.js';
import { inPinQueue } from '../pin.js';
import { config } from './state.js';
import { diag } from './diag.js';
import { pinGuard } from './guards.js';
import { mirrorWanted, offlineMirror } from './session.js';
import { deviceBinding, personalEntries, recentPin, setRecentPin, unlockPersonalWithDk } from './personal.js';

export const unlockService = new UnlockService({
  config: { get: () => config.get(), update: (patch) => config.update(patch) },
  dpapi: {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    protect: async (text) => (await safeStorage.encryptStringAsync(text)).toString('base64'),
    unprotect: async (blob) => (await safeStorage.decryptStringAsync(Buffer.from(blob, 'base64'))).result,
  },
  // Through functions: guards.js imports this module too, pinGuard may not exist yet while this one loads.
  guard: {
    waitSeconds: () => pinGuard.waitSeconds(), failure: () => pinGuard.failure(), success: (o) => pinGuard.success(o), toJSON: () => pinGuard.toJSON(),
  },
  queue: inPinQueue,
  personal: { entries: () => personalEntries(), binding: (id, raw, dk) => deviceBinding(id, raw, dk), unlockWithDk: (dk) => unlockPersonalWithDk(dk).then((r) => afterPersonal(r, dk)) },
  mirror: {
    wanted: () => mirrorWanted(),
    unlockFactor: (f) => offlineMirror().unlockFactor(f),
    switchFactor: (f) => offlineMirror().switchFactor(f),
    remove: () => offlineMirror().remove(),
  },
  recentPin: () => recentPin,
  forgetPin: () => setRecentPin(null),
  diag,
  // #537 stage 3: hello-key.js imports this module – loaded only when a key has to go (new master password).
  removeHelloKey: (name) => import('./hello-key.js').then((m) => m.removeHelloKey(name)),
});

// #539: with the personal vault open, the secured files at the app's master password open too (member key). In the
// background – member-key.js imports this module, so it is loaded when needed.
// Konrad H1: the master password changed on another device – the old DK just proven rescues this device's copy of the
// member keys for the unlock with the new one (member-key.js rescue).
export function openSecuredLater(dk = null) {
  import('./member-key.js').then((m) => m.openSecuredWithMemberKey(dk)).catch((e) => diag(`MEMBERKEY open failed: ${e.message}`));
}
function afterPersonal(r, dk) {
  if (r?.stale?.length) import('./member-key.js').then((m) => m.rescue(dk)).catch(() => {});
  else openSecuredLater(dk);
  return r;
}

export const isMigrated = () => unlockService.isMigrated();
/** #537 stage 3: the organization forbids Windows Hello (policy WindowHello = 0; only false is enforced). */
export const helloAllowed = () => !config.get().enforced?.includes?.('windowHello');
/** For the window; `hello` only while the organization allows it (the wrapper itself goes at the next Hello use). */
export const unlockInfo = () => { const i = unlockService.info(); return { ...i, hello: i.hello && helloAllowed() }; };
export const recentDk = () => unlockService.recentDk();
export const rememberDk = (dk) => unlockService.rememberDk(dk);
export const grantFresh = (purpose) => unlockService.grantFresh(purpose);
export const forgetDk = () => unlockService.forget();
export const checkSecret = (secret, opts) => unlockService.checkSecret(secret, opts);
export const secretMatches = (secret) => unlockService.secretMatches(secret);
export const verifyUnlock = (secret, opts) => unlockService.verifyUnlock(secret, opts);
export const verifyPasswordCounted = (password) => unlockService.verifyPasswordCounted(password);
export const rotate = (password, opened) => unlockService.rotate(password, opened);
export const migrate = (opts) => unlockService.migrate(opts);
export const setPinWrapWithPassword = (password, next) => unlockService.setPinWrapWithPassword(password, next);
export const confirmFresh = (proof, purpose) => unlockService.confirmFresh(proof, purpose);
export const consumeFresh = (purpose) => unlockService.consumeFresh(purpose);
export const mayBind = (entry, ck) => unlockService.mayBind(entry, ck);
export const adoptLineage = (entry, ck) => unlockService.adoptLineage(entry, ck);
