// Settings: enterprise policy (chrome.storage.managed, e.g. via Intune/GPO) overrides user settings.

export const DEFAULTS = {
  tenantId: '',
  clientId: '',
  autoLockMinutes: 30,
  unlockPrompt: 'select_account', // none | select_account | login
  passkeys: true,
  inlineMenu: true,
  savePrompt: true,
  copyTotpOnFill: false,
  clipboardSeconds: 30,
  containers: [], // manually added [{ name, vaultUrl }]
  hiddenContainers: [],
  neverSave: [],
  defaultContainer: '',
  language: 'auto',
  desktopBridge: true,
};

const POLICY_KEYS = ['language', 'desktopBridge', 'tenantId', 'clientId', 'autoLockMinutes', 'unlockPrompt', 'passkeys', 'inlineMenu', 'savePrompt', 'copyTotpOnFill', 'clipboardSeconds'];

export async function getPolicy() {
  try {
    return (await chrome.storage.managed.get(null)) || {};
  } catch {
    return {};
  }
}

export async function getSettings() {
  const [{ settings = {} }, policy] = await Promise.all([chrome.storage.local.get('settings'), getPolicy()]);
  const s = { ...DEFAULTS, ...settings };
  const enforced = [];
  for (const key of POLICY_KEYS) {
    if (policy[key] !== undefined) {
      s[key] = policy[key];
      enforced.push(key);
    }
  }
  s.policyContainers = Array.isArray(policy.containers) ? policy.containers : [];
  s.enforced = enforced;
  return s;
}

export async function updateSettings(patch) {
  const [{ settings = {} }, policy] = await Promise.all([chrome.storage.local.get('settings'), getPolicy()]);
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) continue;
    if (POLICY_KEYS.includes(k) && policy[k] !== undefined) continue;
    clean[k] = v;
  }
  await chrome.storage.local.set({ settings: { ...settings, ...clean } });
  return getSettings();
}
