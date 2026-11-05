// Links to an entry (kvpwsafe://…): copying and opening.

import { toast } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { buildItemLink } from '../../../extension/core/links.js';
import { items, st, ui } from './state.js';
import { copy } from './helpers.js';
import { select } from './sidebar.js';
import { addContainerDialog } from './vault-wizard.js';

/** Functions of an entry (right-click in the list). */
/**
 * "Copy link": a web link to the entry for colleagues (extension/core/links.js). It grants no access – whoever opens
 * it needs rights on the vault; the copy confirmation says so.
 */
export function copyItemLink(container, id) {
  const link = buildItemLink(container, id);
  if (!link) return;
  copy(link, t('Link zum Eintrag'));
  toast(t('Öffnen können ihn alle mit Zugriff auf „{vault}“.', { vault: container.name }));
}

// Entry link that arrived while Keevault was locked or the vault was still missing: opened once that is resolved.
export let pendingItemLink = null;

/** Opens an entry from a link: selects vault and entry; offers to add a vault this app does not know yet. */
export async function openItemLink(link) {
  pendingItemLink = link;
  if (!st?.opened) return; // after unlocking (render)
  const sameHost = (c) => {
    try {
      return new URL(c.vaultUrl || '').host.toLowerCase() === link.host;
    } catch {
      return false;
    }
  };
  const container = st.containers.find(sameHost);
  if (!container) {
    // Not added yet: the invite dialog with the vault prefilled; the entry opens after the vault was added.
    // Only once: closing the dialog without adding drops the link (no dialog on every reload).
    if (link.prompted) {
      pendingItemLink = null;
      return;
    }
    link.prompted = true;
    const invite = new URL('kvpwsafe://add');
    invite.searchParams.set('vault', link.vaultUrl);
    if (link.name) invite.searchParams.set('name', link.name);
    if (!document.querySelector('dialog[open]')) addContainerDialog(invite.toString());
    return;
  }
  pendingItemLink = null;
  const key = `${container.id}/${link.id}`;
  if (!items.some((i) => i.key === key)) {
    if (container.locked) {
      select({ view: 'container', containerId: container.id });
      toast(t('Tresor zuerst entsperren, dann den Link erneut öffnen.'), 'error');
      return;
    }
    toast(t('Eintrag nicht gefunden – gelöscht, verschoben oder kein Zugriff.'), 'error');
    return;
  }
  ui.query = '';
  ui.type = '';
  ui.folder = '';
  select({ view: 'container', containerId: container.id, selected: key });
}
