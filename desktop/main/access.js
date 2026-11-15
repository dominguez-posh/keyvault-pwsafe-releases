// #537 2b "Immer bestätigen" in the app: where the option lives (the personal vault's encrypted app settings, so it
// holds on every device and can't be switched off in the local configuration), what it covers (Lucas 13.11.2026: all
// vaults – the default – or only the personal vault), switching it (only with the master password, the PIN or Windows
// Hello), the confirmations the main process asks itself (browser extension, AI agents, moves) and the sealing of every
// entry that leaves the main process from a vault it covers.
// The rule itself: ../access-confirm.js; the gate instance: guards.js (accessConfirm).

import { t } from '../../extension/core/i18n.js';
import { hasSealed, sealItem, sealedValue, totpPlace, unsealItem } from '../../extension/core/sealed.js';
import { totpCode } from '../../extension/core/totp.js';
import { config, files, vault } from './state.js';
import { accessConfirm, requireOpen } from './guards.js';
import { personalEntries } from './personal.js';
import { askInApp } from './agents.js';
import { usableItem } from './devices.js';
import { changed } from './session.js';
import { diag } from './diag.js';
import { shown } from '../mcp.js';
import { VAULT_WIDE, answerHasItem, sealedAnswer, writeAnswerVault } from '../access-confirm.js';

/** What the option covers: every vault of the app (default) or only the personal vault that holds it. */
export const SCOPES = Object.freeze('all personal'.split(' '));
const scopeOf = (v) => (v === 'personal' ? 'personal' : 'all');

// Konrad (plan): once seen on, a personal vault counts as "on" on this device while its setting can't be read (record
// missing, unreadable, older than one seen before) – removing or replacing the record does not switch the rule off.
// Switching it off writes false. The scope falls back to "all" unless this device saw "only the personal vault".
const list = (name) => (Array.isArray(config.get()[name]) ? config.get()[name].filter((x) => typeof x === 'string') : []);
const known = () => list('confirmEachVaults');
let seen = false;

function remember(containerId, on, scope) {
  const onList = known();
  const personalOnly = list('confirmEachPersonalOnly');
  const next = {};
  if (on && !onList.includes(containerId)) next.confirmEachVaults = [...onList, containerId].slice(-10);
  if (!on && onList.includes(containerId)) next.confirmEachVaults = onList.filter((x) => x !== containerId);
  if (scope === 'personal' && !personalOnly.includes(containerId)) next.confirmEachPersonalOnly = [...personalOnly, containerId].slice(-10);
  if (scope !== 'personal' && personalOnly.includes(containerId)) next.confirmEachPersonalOnly = personalOnly.filter((x) => x !== containerId);
  if (Object.keys(next).length) config.update(next);
}

// Konrad N1: the highest time stamp of the record this device has seen, per personal vault. A record older than that is
// a rollback (an older copy put back into the file): its value does not count, the last known answer does.
const marks = () => (config.get().appSettingsSeen && typeof config.get().appSettingsSeen === 'object' ? config.get().appSettingsSeen : {});
function noteMark(containerId, updated) {
  if (typeof updated !== 'number' || !Number.isFinite(updated) || updated <= (marks()[containerId] || 0)) return;
  const all = Object.entries({ ...marks(), [containerId]: updated }).slice(-10);
  config.update({ appSettingsSeen: Object.fromEntries(all) });
}

/** The rule of one personal vault: { on, scope }. */
async function ruleOf(containerId) {
  let rec;
  try {
    rec = await files.appSettings(containerId);
  } catch {
    rec = undefined; // locked: nothing of it can be read anyway – the last known answer
  }
  const value = rec?.value;
  // The stamp inside the encrypted value (recordAt, filevault.js): a record without one never carries the option.
  const usable = typeof value?.confirmEach === 'boolean' && rec.at > 0;
  if (usable && rec.at < (marks()[containerId] || 0)) {
    diag('ACCESS confirm-each: older app settings record than seen before (rollback) – last known answer');
  } else if (usable) {
    noteMark(containerId, rec.at);
    const scope = scopeOf(value.confirmEachScope);
    remember(containerId, value.confirmEach, scope);
    return { on: value.confirmEach, scope };
  }
  return { on: known().includes(containerId), scope: list('confirmEachPersonalOnly').includes(containerId) ? 'personal' : 'all' };
}

/**
 * Does this vault want a confirmation for every use? Yes when a personal vault of this device has the option on and it
 * covers all vaults, or this vault is that personal vault.
 */
export async function strictVault(containerId) {
  if (typeof containerId !== 'string' || !containerId || !vault) return false;
  for (const entry of personalEntries()) {
    const rule = await ruleOf(entry.id);
    if (rule.on) seen = true;
    if (rule.on && (rule.scope === 'all' || entry.id === containerId)) return true;
  }
  return false;
}

/** Is the rule on in any personal vault of this device? (Every passkey use then asks, passkey-pin.js.) */
export async function anyStrictVault() {
  let on = false;
  for (const entry of personalEntries()) if ((await ruleOf(entry.id)).on) on = true;
  seen = on;
  return on;
}

/** The last known answer of anyStrictVault, for dialogs that must know before they ask (never decides alone). */
export const strictSeen = () => seen || known().length > 0;

/** The entry as it may leave the main process: sealed when its vault wants a confirmation. */
export async function sealFor(containerId, item) {
  return item && (await strictVault(containerId)) ? sealItem(item) : item;
}

/** The answer of a write (an entry, or { saved, … }) as it may leave the main process for the vault it is in now. */
export async function sealAnswer(containerId, result) {
  if (typeof containerId !== 'string' || !answerHasItem(result) || !(await strictVault(containerId))) return result;
  return sealedAnswer(result, sealItem);
}

/** Konrad M1: the answer of `method` for the window ('window') or the extension ('bridge'), sealed for write answers. */
export async function answerFor(side, method, args, result) {
  const where = writeAnswerVault(side, method, args);
  return where === null ? result : sealAnswer(where, result);
}

/**
 * Before a save: markers of a sealed entry get the stored values back (whatever the caller sends, secrets stay).
 * Konrad H1: only in a vault the rule covers, and only at exactly their own place (sealed.js) – else nothing is saved.
 */
export async function unsealForSave(containerId, item) {
  if (!item || typeof item !== 'object') return item;
  const { linkedSource, sealed, ...rest } = item; // what the window was handed along is never stored
  if (!hasSealed(rest)) return rest;
  if (!(await strictVault(containerId))) throw new Error(t('Der Eintrag ist nicht mehr aktuell. Bitte neu laden.'));
  const stored = rest.id ? await vault.getItem(containerId, rest.id, { fresh: true }) : null; // not readable → nothing is saved
  try {
    return unsealItem(rest, stored);
  } catch (e) {
    if (e.name !== 'SealedPlace') throw e;
    diag('ACCESS confirm-each: save refused, a held-back value at a wrong place');
    throw Object.assign(new Error(t('Ein zurückgehaltener Wert steht an einer falschen Stelle – nichts gespeichert.')), { name: 'SealedPlace' });
  }
}

/** The entry with its secrets for one confirmed use (the confirmation is used up). Linked logins resolved here. */
export async function revealed(containerId, itemId, purpose) {
  await accessConfirm.require(containerId, itemId, purpose);
  const item = await usableItem(containerId, itemId);
  accessConfirm.noteRevealed(containerId, item);
  return item;
}

/** One secret of an entry for one confirmed copy: the value at a secret place, the current code for TOTP places. */
export async function secretFor(containerId, itemId, path) {
  await accessConfirm.require(containerId, itemId, 'copy');
  const item = await usableItem(containerId, itemId);
  const place = String(path || '');
  const value = sealedValue(item, place);
  if (!value) throw new Error(t('Nicht gefunden'));
  if (!totpPlace(item, place)) return value;
  const c = await totpCode(value).catch(() => null);
  if (!c) throw new Error(t('Kein Einmalcode (TOTP) hinterlegt'));
  return c.code;
}

/**
 * Konrad H2: an entry leaving a vault the rule covers – into another vault, where it may not hold – needs a confirmation
 * for exactly this entry ('move'). The window: confirmAccess first (AccessConfirmRequired tells it to).
 */
export async function requireMove(fromId, toId, itemId) {
  if (fromId === toId) return false;
  return accessConfirm.require(fromId, itemId, 'move');
}

/**
 * Konrad N-A: a backup of a vault the rule covers ('backup') and giving someone access to it ('share': members, guests,
 * invites, passkeys, switching protection off) need a confirmation for that vault. The window: confirmAccess(containerId,
 * '*', purpose) first (AccessConfirmRequired tells it to).
 */
export const requireVaultUse = (containerId, purpose) => accessConfirm.require(containerId, VAULT_WIDE, purpose);

const PURPOSE_TEXT = {
  fill: 'Die Browser-Erweiterung möchte die Zugangsdaten von „{title}“ verwenden',
  fillSite: 'Die Browser-Erweiterung möchte die Zugangsdaten von „{title}“ auf {site} verwenden',
  copy: 'Die Browser-Erweiterung möchte einen Wert von „{title}“ kopieren',
  move: 'Die Browser-Erweiterung möchte „{title}“ in einen anderen Tresor verschieben',
  agent: '„{agent}“ möchte „{title}“ lesen',
};
const SITE = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i;

/**
 * A confirmation the main process asks itself, in the app window: the request with entry and vault (for filling, the
 * page the browser names), a field for the master password or PIN and the Windows Hello button; "Allow" holds only with
 * the right proof (counted). On a locked window it shows without entry and vault (agents.js). → true/false
 */
export async function askAccess({ containerId, itemId, purpose, agent = '', site = '' }) {
  const [c, item] = await Promise.all([vault.container(containerId), vault.getItem(containerId, itemId).catch(() => null)]);
  const title = item?.title || '';
  const page = typeof site === 'string' && SITE.test(site) ? site.toLowerCase() : '';
  const text = purpose === 'fill' && page ? PURPOSE_TEXT.fillSite : PURPOSE_TEXT[purpose] || PURPOSE_TEXT.fill;
  const answer = await askInApp({
    kind: agent ? 'agent-confirm-each' : 'confirm-each',
    ...(agent ? { agent: shown(agent) } : {}),
    title: t(text, { title, agent: shown(agent), site: page }),
    lead: t('Für diesen Tresor gilt „Immer bestätigen“. Bestätige nur, wenn du das gerade selbst angestoßen hast.'),
    entry: title,
    vault: c?.name || '',
    ...(page ? { note: t('Seite laut Browser: {site}', { site: page }) } : {}),
    allow: t('Bestätigen'),
    cancel: 'deny',
  }, { check: (proof) => accessConfirm.prove(proof) });
  diag(`ACCESS confirm-each ${purpose}: ${answer === 'allow' ? 'confirmed' : 'refused'}`);
  return answer === 'allow';
}

/** For the extension and agents: asks in the app when the vault wants it; refused → error. → true when it asked. */
export async function confirmInApp(containerId, itemId, purpose, agent = '', site = '') {
  if (!(await strictVault(containerId))) return false;
  if (!(await askAccess({ containerId, itemId, purpose, agent, site }))) throw new Error(t('Im Keevault-Fenster nicht bestätigt'));
  return true;
}

/** Konrad H2 for the extension: a move out of a vault the rule covers is confirmed in the app with a proof. */
export async function confirmMoveInApp(fromId, toId, itemId) {
  if (fromId === toId) return false;
  return confirmInApp(fromId, itemId, 'move');
}

// ---------------------------------------------------------------- the option

const personalEntry = (containerId) => {
  const entry = personalEntries().find((e) => e.id === containerId);
  if (!entry || !entry.vault || entry.vault.locked) throw new Error(t('Nur für den entsperrten persönlichen Tresor'));
  return entry;
};

/** → { on, scope } for the window (protection dialog of the personal vault). */
export async function confirmEachState(containerId) {
  requireOpen();
  personalEntry(containerId);
  return ruleOf(containerId);
}

/**
 * Switches the option and what it covers ('all' – the default – or 'personal'): on, off and the scope only with a fresh
 * proof (master password, PIN or { hello: true }), counted.
 */
export async function setConfirmEach(containerId, on, proof, scope = 'all') {
  requireOpen();
  const entry = personalEntry(containerId);
  if (!SCOPES.includes(scope)) throw new Error(t('Unbekannter Umfang'));
  await accessConfirm.prove(proof, 'confirmEach');
  const want = on === true;
  const { updated } = await files.updateAppSettings(entry.id, (value) => ({ ...value, confirmEach: want, confirmEachScope: scope }));
  noteMark(entry.id, updated);
  remember(entry.id, want, scope);
  seen = want || (await anyStrictVault());
  diag(`ACCESS confirm-each ${want ? `on (${scope})` : 'off'}`);
  changed();
  return { on: want, scope };
}
