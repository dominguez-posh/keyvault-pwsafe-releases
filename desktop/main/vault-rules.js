// #480: the rules and protection defaults of a vault's settings, enforced in the main process for every caller (window,
// extension, MCP) – not only in the window. These are app rules, not a security boundary against someone who reads the
// vault in Azure directly (docs/ENTSCHEIDUNGEN.md).

import crypto from 'node:crypto';
import { readVaultSettings, requireFields } from '../../extension/core/vault-settings.js';
import { totpMatches } from '../../extension/core/totp.js';
import { t } from '../../extension/core/i18n.js';
import { config, vault } from './state.js';
import { copyPin } from './guards.js';

/** Settings of a vault for a rule check; a read error gives the last stored ones (readVaultSettings). */
export const rulesOf = (containerId) => readVaultSettings(vault, containerId);

/** Group 3: a save that leaves a required field of the vault empty is refused (names the fields). */
export async function checkRequired(containerId, item) {
  if (item) requireFields(item, await rulesOf(containerId));
}

// ---------------------------------------------------------------- group 4: protection defaults

// Secret values handed out from vaults that want the PIN for copying: a copy of one of them needs the PIN, also when the
// caller (the extension) does not say which vault it comes from. Only hashes, a bounded number.
const served = new Map(); // sha256(value) → containerId
const SERVED_MAX = 5000;
// TOTP codes (review 0.9.33): the extension computes the code itself and only hands the code to copy. Entries with a TOTP
// that were handed out from such a vault are noted (no secret kept here), and a copied 6–8 digit text is compared with
// their codes of the previous, current and next period.
const servedTotp = new Map(); // "containerId/itemId" → { containerId, itemId }
const SERVED_TOTP_MAX = 500;
const digest = (text) => crypto.createHash('sha256').update(String(text)).digest('base64');

const secretValues = (item) => [
  item.password, item.server?.tvPassword, item.card?.number, item.card?.cvc, item.card?.pin,
  ...(item.fields || []).filter((f) => f.hidden || f.type === 'hidden').map((f) => f.value),
].filter((v) => typeof v === 'string' && v.length >= 3);

/** Notes the secrets of an entry just read, when its vault wants the PIN for copying. → the item */
export async function noteServed(containerId, item) {
  if (!item || !(await rulesOf(containerId).catch(() => null))?.protect.pinCopy) return item;
  for (const v of secretValues(item)) {
    if (served.size >= SERVED_MAX) served.delete(served.keys().next().value);
    served.set(digest(v), containerId);
  }
  if (item.totp && item.id) {
    if (servedTotp.size >= SERVED_TOTP_MAX) servedTotp.delete(servedTotp.keys().next().value);
    servedTotp.set(`${containerId}/${item.id}`, { containerId, itemId: item.id });
  }
  return item;
}

/** The vaults whose handed-out TOTP entries currently show this code (previous, current or next period). */
async function totpVaults(text) {
  const out = new Set();
  if (!/^\d{6,8}$/.test(text)) return out;
  for (const { containerId, itemId } of servedTotp.values()) {
    if (out.has(containerId)) continue;
    const item = await vault.getItem(containerId, itemId).catch(() => null);
    if (item?.totp && (await totpMatches(item.totp, text).catch(() => false))) out.add(containerId);
  }
  return out;
}

/**
 * Before text goes to the clipboard: the vault it comes from (containerId, if the caller names it) and the vault that
 * handed out this value want the PIN → it must have been confirmed (copyPin) a moment ago.
 */
export async function checkCopy(text, containerId = null) {
  const ids = new Set([containerId, served.get(digest(text)), ...(await totpVaults(String(text)))].filter(Boolean));
  for (const id of ids) {
    const rules = await rulesOf(id).catch(() => null);
    if (rules?.protect.pinCopy) copyPin.require(id);
  }
}

/** Export: refused when the vault forbids it; → true when the vault wants the PIN (the export then needs it). */
export async function checkExport(containerId) {
  const { protect } = await rulesOf(containerId);
  if (protect.noExport) throw new Error(t('Der Export ist für diesen Tresor gesperrt.'));
  if (protect.pinExport && !config.get().appPin) throw new Error(t('Dieser Tresor verlangt die App-PIN. Lege zuerst in den Einstellungen eine App-PIN fest.'));
  return protect.pinExport;
}

/**
 * Review 0.9.33: the export lock can't be bypassed through the personal vault (which exports). Moving or copying an entry
 * from a vault with the export lock into the personal vault is refused – also where moving into it is allowed otherwise.
 */
export async function checkLeaveToPersonal(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const [from, to] = await Promise.all([vault.container(fromId), vault.container(toId)]);
  if (!to?.personal || from?.personal) return;
  const rules = await rulesOf(fromId); // a read error refuses – the export lock must not open by failing
  if (rules?.protect.noExport) throw new Error(t('Der Tresor „{name}“ sperrt den Export – Einträge daraus lassen sich nicht in den persönlichen Tresor verschieben oder kopieren.', { name: from.name }));
}

/** Locking the app forgets what was handed out and every confirmation. */
export function clearCopyRules() {
  served.clear();
  servedTotp.clear();
  copyPin.clear();
}
