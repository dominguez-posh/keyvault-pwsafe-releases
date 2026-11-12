// #507: the settings while the session is open for the browser extension only and the window keeps its lock screen.
// Allowlists: the window sees and changes only what its lock screen needs; anything not listed stays out.

/** What the locked window may see: language, view, updates and the flags that pick the lock screen. */
export const LOCK_SCREEN_SETTINGS = Object.freeze(['language', 'theme', 'zoom', 'transparency', 'updateMode', 'updateChannel', 'selfUpdate',
  'otherInstallDismissed', 'requirePin', 'passkeyPin', 'entraUsed', 'setupOffered', 'enforced']);

/**
 * What the locked window may change: language, the second-installation hint and the view. Not the updates (review
 * 0.9.33): update mode and channel decide what gets installed, and the locked window must not switch them.
 */
export const LOCK_SCREEN_WRITABLE = Object.freeze(['language', 'otherInstallDismissed', 'theme', 'zoom', 'transparency']);

// Lists the window reads before it knows it is locked: there, but always empty.
const EMPTY_LISTS = () => ({ containers: [], policyContainers: [], fileContainers: [], hiddenContainers: [], containerOrder: [] });

/** The settings the locked window gets; `language` overrides the stored one (a language forced by policy). */
export function lockScreenSettings(all, language = '') {
  const out = EMPTY_LISTS();
  for (const key of LOCK_SCREEN_SETTINGS) if (Object.hasOwn(all || {}, key)) out[key] = all[key];
  if (language) out.language = language;
  return out;
}

/** Keys of a settings patch the locked window may not change (empty: the patch may pass). */
export const lockScreenRefused = (patch) => Object.keys(patch || {}).filter((key) => !LOCK_SCREEN_WRITABLE.includes(key));
