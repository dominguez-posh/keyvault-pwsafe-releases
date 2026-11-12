// #480: how a vault looks by its settings (colour, symbol, short description) – desktop sidebar and vault head, and the
// extension. Values come cleaned from vault-settings.js; here they are checked once more against the fixed lists,
// because the extension gets them over native messaging.

import { h, icon } from './dom.js';
import { t } from './i18n.js';
import { DESCRIPTION_MAX, VAULT_COLORS, VAULT_ICONS, cleanEmail } from './vault-settings.js';

/** { color, icon, description } of a container (desktop: c.vaultSettings.look, extension: c.look), each '' when unset. */
export function vaultLook(c) {
  const l = c?.vaultSettings?.look || c?.look || {};
  return {
    color: VAULT_COLORS.includes(l.color) ? l.color : '',
    icon: VAULT_ICONS.includes(l.icon) ? l.icon : '',
    description: typeof l.description === 'string' ? l.description.slice(0, DESCRIPTION_MAX) : '',
  };
}

/** Symbol of the vault in its colour; fallback: the symbol without settings. */
export function vaultIcon(c, fallback = 'vault', size = 16) {
  const look = vaultLook(c);
  const el = icon(look.icon || fallback, size);
  if (look.color) el.dataset.vaultColor = look.color;
  el.classList.add('vault-symbol');
  return el;
}

/** Small colour dot (lists where the vault is only named), or null. */
export function vaultDot(c) {
  const { color } = vaultLook(c);
  return color ? h('span', { class: 'vault-dot', dataset: { vaultColor: color }, 'aria-hidden': 'true' }) : null;
}

/** The vault's short description as a line of text, or null. */
export function vaultDescription(c, cls = 'vault-description muted small') {
  const { description } = vaultLook(c);
  return description ? h('p', { class: cls }, description) : null;
}

/** { name, email } of the vault's contact person, or null (desktop only: from c.vaultSettings). */
export function vaultContact(c) {
  const k = c?.vaultSettings?.contact;
  const name = typeof k?.name === 'string' ? k.name : '';
  const email = cleanEmail(k?.email);
  return name || email ? { name, email } : null;
}

/**
 * "Ansprechpartner: Name · mail" as text; the address opens the mail program (mailto: only, through onMail) – never a
 * link of the vault's own choosing.
 */
export function contactLine(c, onMail) {
  const k = vaultContact(c);
  if (!k) return null;
  return h('div', { class: 'vault-contact notice info' },
    h('strong', {}, t('Ansprechpartner für diesen Tresor:')), ' ', k.name || null, k.name && k.email ? ' · ' : null,
    k.email ? (onMail ? h('button', { type: 'button', class: 'linklike', onclick: () => onMail(k.email) }, k.email) : h('span', {}, k.email)) : null);
}
