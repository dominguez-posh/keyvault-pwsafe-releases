// Which input gets the field menu (#502): only real sign-in fields. Before, any text field whose name, id, placeholder or
// autocomplete held "e-mail", "account", "user", "login" … counted as a user name, so contact forms, newsletter boxes,
// search boxes ("Search users") and comment forms got a Keevault suggestion too.
// A field counts when it is
// - a password field, or a field the page marks for a passkey (autocomplete webauthn) or a one-time code,
// - marked for a user name (autocomplete username),
// - the name field that belongs to a shown password field (the same one the filling takes, loginFields),
// - with no password shown: the name step of a known sign-in page (Microsoft asks for the name on a page of its own and
//   keeps the password as an invisible copy there, #463), or a field clearly named for a user name or login.
// Never: search fields, textarea (not an input), a field marked for something else (autocomplete email, address, postal
// code, …) without a shown password next to it, autocomplete="off" without a shown password.
// helpers: { host, isOtp, loginFields } from content.js.
globalThis.kvpwsafeFieldKind = (() => {
  const SIGN_IN_HOSTS = /(^|\.)(login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com)$/i;
  const TEXT_TYPES = ['text', 'email', 'tel', ''];
  const SEARCH_HINT = /search|suche/i;
  const SEARCH_NAMES = ['q', 's', 'query', 'keyword', 'keywords'];
  // A field clearly named for the account's name. "e-mail" alone is not one: contact forms and newsletters ask for it too.
  const NAME_HINT = /user.?name|user.?id|\buser\b|log.?in|identifier|benutzer|anmelde|kennung|account.?name|kontoname/i;
  // Tokens that leave the OTP guess by name alone open: anything else names another purpose (postal-code, street-address, …).
  const NEUTRAL = ['', 'on', 'off', 'one-time-code'];

  const tokens = (el) => String(el.getAttribute?.('autocomplete') ?? el.autocomplete ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const hint = (el) => `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute?.('aria-label') || ''}`;
  const hidden = (e) => e.getAttribute?.('aria-hidden') === 'true' || !!e.classList?.contains('moveOffScreen') || getComputedStyle(e).opacity === '0';
  const role = (e) => String(e?.getAttribute?.('role') || '').toLowerCase();
  const searchLike = (el, ac, form) => el.type === 'search' || ac.includes('search') || role(el) === 'searchbox' || role(form) === 'search'
    || !!el.closest?.('[role=search], search') || SEARCH_NAMES.includes(String(el.name || '').toLowerCase()) || SEARCH_NAMES.includes(String(el.id || '').toLowerCase())
    || SEARCH_HINT.test(hint(el));

  return function fieldKind(el, { host = '', isOtp, loginFields }) {
    const ac = tokens(el);
    if (ac.includes('webauthn')) return 'webauthn';
    if (ac.includes('one-time-code')) return 'otp';
    if (isOtp(el)) return ac.every((t) => NEUTRAL.includes(t)) && !searchLike(el, ac, el.form) ? 'otp' : null;
    if (el.type === 'password') return 'password';
    if (!TEXT_TYPES.includes(el.type)) return null;
    const form = el.form || el.closest?.('form') || null;
    if (searchLike(el, ac, form)) return null;
    if (ac.includes('username')) return 'username';
    // A shown password: only the name field that belongs to it.
    const f = loginFields(form || document);
    if (f.password && !hidden(f.password)) return f.username === el ? 'username' : null;
    // No password shown: a name step of its own.
    if (SIGN_IN_HOSTS.test(host)) return 'username';
    if (ac.length && !ac.every((t) => t === 'on')) return null; // off, email, name, address, …
    return NAME_HINT.test(hint(el)) ? 'username' : null;
  };
})();
