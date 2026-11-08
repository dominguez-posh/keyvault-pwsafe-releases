// #472: Enter in a PIN field (agent request, Windows passkey confirmation) confirms only when the whole PIN was typed by
// hand after the dialog appeared. Pasted, dropped, filled in by the browser or set by a script, the field's value does not
// count, nor does a PIN shorter than the app's minimum: then Enter does nothing and only the button confirms, with its
// delay (#368, #405). No DOM here, so the unit test can feed it events.

export const MIN_PIN_LENGTH = 6; // same as desktop/pin.js (the window can't import Node modules)

// Typed by hand: a key that inserts text, or one that deletes. Everything else (paste, drop, autofill, IME) is not.
const TYPED = (type) => type === 'insertText' || String(type || '').startsWith('delete');

/** Tracks one PIN field from the moment its dialog appeared (shownAt, same clock as Event.timeStamp). */
export function pinTyping(shownAt = performance.now()) {
  let clean = true;
  let seen = '';
  return {
    /** Every beforeinput event, with the field's value before the change: a value set without typing shows up here. */
    before(value) {
      if (String(value || '') !== seen) clean = false;
    },
    /** Every input event of the field, with the field's value after it. */
    input(e, value) {
      if (!value) {
        clean = true;
        seen = '';
        return;
      }
      if (!(e?.isTrusted && e.timeStamp >= shownAt && TYPED(e.inputType))) clean = false;
      seen = value;
    },
    /** The field was cleared by the app (wrong PIN): what was there before no longer counts either way. */
    reset() {
      clean = true;
      seen = '';
    },
    /**
     * The dialogs shown changed (a request came or went): the keys typed so far lapse. Enter counts again only after the
     * field was cleared and the PIN typed anew, from now on.
     */
    expire(at = performance.now()) {
      shownAt = at;
      if (seen) clean = false;
    },
    /** Enter may confirm: the value is the one the typed keys produced, and it is long enough. */
    ready(value) {
      const v = String(value || '');
      return clean && v === seen && v.length >= MIN_PIN_LENGTH;
    },
  };
}

/**
 * #472 (review): the requests open in the window (agent questions, Windows passkey dialogs). Enter in a PIN field may
 * confirm only while exactly one is open, otherwise it could answer a request that appeared later over the one the user
 * meant. Every change of the set lets the typed keys of all PIN fields lapse and tells each dialog whether Enter works.
 */
export function openRequests(now = () => performance.now()) {
  const open = new Map(); // key → { typing, changed }
  const notify = () => {
    const at = now();
    const single = open.size === 1;
    for (const r of open.values()) {
      r.typing?.expire(at);
      r.changed?.(single);
    }
  };
  return {
    /** A request dialog appeared; typing is its PIN tracker (or null), changed(single) is called on every change. */
    add(key, typing = null, changed = null) {
      open.set(key, { typing, changed });
      notify();
    },
    remove(key) {
      if (open.delete(key)) notify();
    },
    /** Enter may confirm: this request is the only one open. */
    single(key) {
      return open.size === 1 && open.has(key);
    },
    get size() { return open.size; },
  };
}
