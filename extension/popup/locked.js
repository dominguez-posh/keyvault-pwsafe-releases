// The popup's views while the vault is not usable: the app is not running or missing (renderOffline), or it is locked
// (renderLocked, with the app PIN right here when one is set). The PIN is checked by the app only.

import { h, icon, toast } from '../core/dom.js';
import { getLanguage, t } from '../core/i18n.js';
import { call, unlockError } from '../lib/api.js';

/**
 * ctx: { setView(...children), state() → the popup's current state, reload(), load(), pinReady() → called when the
 * PIN field is on the page and focused (#534, for the smoke test) }.
 * → { renderOffline, renderLocked, confirm, unlocking() } – unlocking() is true while an unlock with the PIN runs (#508).
 */
export function lockedViews({ setView, state, reload, load, pinReady }) {
  let unlocking = false; // #508: an unlock with the PIN is running (the busy button stays)

  /** The extension works only through the running app. */
  function renderOffline() {
    const st = state();
    const missing = st.desktop?.reason === 'AppMissing';
    const start = h('button', { class: 'btn primary', onclick: async () => {
      start.disabled = true;
      start.replaceChildren(h('span', { class: 'spinner' }), t('Keevault startet …'));
      // The popup reloads by itself once the app is reachable (state:changed).
      await call('unlock').catch((e) => toast(e.message, 'error'));
    } }, icon('unlock'), t('Keevault starten'));
    setView(h('div', { class: 'center' }, icon('shield', 40), h('h2', {}, missing ? t('Keevault-App fehlt') : t('Keevault-App läuft nicht')),
      h('p', { class: 'muted' }, missing
        ? t('Die Erweiterung arbeitet nur zusammen mit der Desktop-App. Installiere Keevault auf diesem Computer.')
        : t('Die Erweiterung arbeitet nur zusammen mit der Desktop-App. Starte Keevault – danach geht es hier sofort weiter.')),
      missing ? h('a', { class: 'btn primary', href: 'https://keevault.de/download.html', target: '_blank', rel: 'noopener' }, t('Keevault herunterladen')) : start,
      // #495: after starting or installing the app by hand, without closing the popup.
      h('button', { type: 'button', class: 'btn load-retry', onclick: load }, icon('refresh', 15), t('Erneut versuchen'))));
  }

  /**
   * #534: the PIN view drawn from the last known state (pending) before the app has answered. popup/early.js puts the
   * field there with the first paint; this view takes that very field over (typed digits and a PIN already sent stay).
   * A PIN sent meanwhile is held in the popup and goes to the app only once the fresh state confirms the connection to
   * the app (hello done, #511) with the vault locked and a PIN set (confirm). Any other fresh state draws its own view
   * over this one, and a held PIN goes with it, unsent.
   */
  let draft = null; // { pin, held, confirmed, send } of the PIN view drawn ahead

  /** Konrad (#534): a PIN view drawn ahead that is not used goes without leaving its digits behind. */
  function dropDraft() {
    if (draft?.pin) draft.pin.value = '';
    draft = null;
  }

  function renderLocked(error, { pending = false } = {}) {
    const st = state();
    // With an app PIN the vault unlocks right here (silent sign-in in the app, no window).
    const pinSet = pending || (!st.demo && !!st.desktop?.pinSet);
    dropDraft();
    const early = pending ? document.querySelector('#view input.pin-early') : null;
    if (pending) {
      window.kvPinAdopted = true; // early.js stops drawing and handling keys
      window.kvEarlyRelease?.(); // and lets go of the field
    }
    const pin = early || (pinSet ? h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: t('PIN'), 'aria-label': t('PIN') }) : null);
    // #508: unlocking can take a while (silent sign-in, then the vaults): the button says what is going on, the field is
    // locked meanwhile; a wrong PIN or a timeout comes back as a clear message above the field.
    const here = pinSet || st?.demo;
    const busy = (label) => button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), label);
    const send = async () => {
      button.disabled = true;
      if (pin) pin.disabled = true;
      if (here) busy(t('Entsperre …'));
      unlocking = true;
      try {
        if (pin) {
          const value = pin.value;
          pin.value = ''; // Konrad (#534): the digits stay in the page no longer than needed
          await call('unlockPin', { pin: value });
        } else await call('unlock');
        unlocking = false;
        if (here) {
          busy(t('Lade Tresore …'));
          await reload();
        }
      } catch (e) {
        unlocking = false;
        renderLocked(unlockError(e));
      }
    };
    const mine = pending ? { pin, held: false, confirmed: false, send } : null;
    draft = mine;
    // #534: not confirmed yet – the PIN stays in this page until confirm().
    const hold = () => {
      mine.held = true;
      pin.readOnly = true;
      button.disabled = true;
      busy(t('Verbinde mit Keevault …'));
    };
    const button = h('button', { class: 'btn primary', 'aria-live': 'polite', onclick: () => {
      if (pin && !pin.value) return pin.focus();
      if (mine && !mine.confirmed) return mine.held ? undefined : hold();
      return send();
    } }, icon('unlock'), here ? t('Entsperren') : t('In der Desktop-App entsperren'));
    if (early?.dataset.held) hold();
    pin?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') button.click();
    });
    setView(h('div', { class: 'center' }, icon('lock', 40), h('h2', {}, t('Tresor gesperrt')),
      h('p', { class: 'muted' }, pinSet ? t('PIN eingeben – Keevault entsperrt im Hintergrund, ohne Fenster.') : t('Entsperre Keevault in der Desktop-App – danach geht es hier sofort weiter.')),
      error ? h('div', { class: 'notice error' }, error) : null,
      pin,
      button));
    // #534: focused at once (the timeout catches a page that gets its focus a moment later).
    const focus = () => {
      if (!pin?.isConnected) return;
      pin.focus();
      if (document.activeElement === pin) pinReady?.();
    };
    focus();
    setTimeout(focus, 0);
  }

  /**
   * #534: the fresh state for a PIN view drawn ahead. True when it confirms that view (app connected, locked, PIN set):
   * the view stays as it is – typed digits and focus included – and a held PIN goes to the app now. False: nothing
   * drawn ahead, or a state that needs its own view.
   */
  function confirm(st) {
    const mine = draft;
    if (!mine) return false;
    if (!mine.pin.isConnected || st.open || st.demo || !st.desktop?.connected || !st.desktop.pinSet) {
      dropDraft(); // a held PIN is discarded, unsent
      return false;
    }
    if (mine.confirmed) return true;
    mine.confirmed = true;
    if (mine.held) {
      draft = null;
      mine.send();
    }
    return true;
  }

  return { renderOffline, renderLocked, confirm, unlocking: () => unlocking };
}

// #534: the last fresh state, as far as the PIN view needs it – flags, the language and the view's texts in it, nothing
// else. In chrome.storage.session: gone with the browser session, readable only by the extension's own pages.
const LAST = 'popupLast';

/** After setLanguage: the texts are stored translated, so popup/early.js needs no dictionary. */
export function rememberState(st) {
  const texts = { lang: getLanguage(), title: t('Tresor gesperrt'), hint: t('PIN eingeben – Keevault entsperrt im Hintergrund, ohne Fenster.'),
    pin: t('PIN'), button: t('Entsperren'), connecting: t('Verbinde mit Keevault …') };
  const last = { demo: !!st.demo, connected: !!st.desktop?.connected, open: !!st.open, pinSet: !!st.desktop?.pinSet, language: st.settings?.language || 'auto', texts };
  chrome.storage.session.set({ [LAST]: last }).catch(() => {});
}

/** → the last known state when it was "app running, locked, PIN set" (the PIN view can be drawn ahead), else null. */
export async function lockedWithPin() {
  const last = await chrome.storage.session.get(LAST).then((r) => r[LAST], () => null);
  return last && !last.demo && last.connected && !last.open && last.pinSet ? last : null;
}
