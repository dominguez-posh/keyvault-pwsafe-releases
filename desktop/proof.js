// #537 stage 4: what a gate (passkey use, copy, export, admin mode) accepts as proof of the person – the master password
// or the PIN wrapper as text, or { hello: true }: then the main process asks Windows Hello itself, for this one use
// (Konrad: proofs are purpose-bound and used once – no Hello answer is kept, an unlock by Hello is no passkey proof).
// The window or the extension only says which kind it wants; they never deliver a Hello result. No Electron (unit tests).

import { t } from '../extension/core/i18n.js';

export const HELLO_PROOF = Object.freeze({ hello: true });

/** { hello: true } – the only object a proof may be. */
export const isHelloProof = (proof) => !!proof && typeof proof === 'object' && proof.hello === true;

/** The proof as it reaches a gate: a Hello request, or the typed secret as text ('' when none). */
export const normalizeProof = (proof) => (isHelloProof(proof) ? HELLO_PROOF : typeof proof === 'string' ? proof : '');

/** Once the master password is set up the gates say so instead of "App-PIN". */
export const migrated = (settings) => !!settings?.unlockKeys?.blob;

export const askSecretText = (settings) => (migrated(settings) ? t('Bitte Masterpasswort, PIN oder Windows Hello verwenden') : t('Bitte die App-PIN eingeben'));

export const wrongSecretText = (settings, seconds) => {
  if (migrated(settings)) return seconds ? t('Falsches Masterpasswort oder falsche PIN – bitte {seconds} Sekunden warten', { seconds }) : t('Falsches Masterpasswort oder falsche PIN');
  return seconds ? t('Falsche PIN – bitte {seconds} Sekunden warten', { seconds }) : t('Falsche PIN');
};

const blocked = (guard) => {
  const wait = guard.waitSeconds();
  if (wait) throw Object.assign(new Error(t('Zu viele falsche Versuche – bitte {seconds} Sekunden warten', { seconds: wait })), { name: 'PinBlocked' });
};

/**
 * A gate's proof with the PIN queue (Konrad, review of stage 4): a typed secret is checked in the queue; Windows Hello is
 * asked OUTSIDE it (a Hello dialog may take minutes and must not hold up every other PIN check), and only the wait check
 * before, and success and saving after, run in the queue. after() runs in the queue once the proof holds → its result.
 */
export async function runProof(proof, opts, queue, after) {
  if (!isHelloProof(proof)) return queue(async () => { await checkProof(proof, opts); return after(); });
  await queue(async () => blocked(opts.guard));
  if (!opts.hello) throw Object.assign(new Error(t('Windows Hello ist zum Entsperren nicht eingeschaltet – bitte das Masterpasswort eingeben')), { name: 'HelloOff' });
  await opts.hello(opts.purpose);
  return queue(async () => {
    blocked(opts.guard);
    opts.guard.success({ unlock: false }); // a gate never opens the one unlock a proof allows
    opts.save(null);
    return after();
  });
}

/**
 * Checks a proof inside a gate (already in the PIN queue). verify(text) → bool; hello(purpose) → resolves after a fresh
 * Hello confirmation (throws HelloCanceled, HelloUnavailable … – those count nothing: no secret was guessed).
 * guard: the shared PinGuard; save(state) persists it. → true; throws PinBlocked, PinRequired, PinWrong or Hello errors.
 */
export async function checkProof(proof, { settings, guard, save, verify, hello, purpose }) {
  const fail = (name, message) => Object.assign(new Error(message), { name });
  const wait = guard.waitSeconds();
  if (wait) throw fail('PinBlocked', t('Zu viele falsche Versuche – bitte {seconds} Sekunden warten', { seconds: wait }));
  if (isHelloProof(proof)) {
    if (!hello) throw fail('HelloOff', t('Windows Hello ist zum Entsperren nicht eingeschaltet – bitte das Masterpasswort eingeben'));
    await hello(purpose);
    guard.success({ unlock: false }); // a gate never opens the one unlock a proof allows
    save(null);
    return true;
  }
  if (typeof proof !== 'string' || !proof) throw fail('PinRequired', askSecretText(settings));
  if (await verify(proof)) {
    guard.success({ unlock: false });
    save(null);
    return true;
  }
  guard.failure();
  save(guard.toJSON());
  throw fail('PinWrong', wrongSecretText(settings, guard.waitSeconds()));
}
