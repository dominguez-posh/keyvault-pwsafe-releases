// Reports and reminders: context of the password check, expired entries.

import { toast } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { expiringEntries, daysUntil } from '../../../extension/core/health.js';
import { call } from './ipc.js';
import { items, st, ui } from './state.js';
import { containerName } from './helpers.js';
import { render } from './shell.js';

export function reportCtx(containerId = null) {
  return {
    call,
    containerId,
    containerName,
    openItem: (i) => {
      ui.view = 'container';
      ui.containerId = i.containerId;
      ui.folder = i.folder || '';
      ui.folderOf = i.containerId;
      ui.selected = i.key;
      ui.editing = null;
      render();
    },
  };
}

export let expiryReminded = false;

/** Once per unlock: entries that have expired or expire within 30 days. */
export function expiryReminder() {
  if (expiryReminded || !st?.opened) return;
  const due = expiringEntries(items);
  if (!due.length) return;
  expiryReminded = true;
  const expired = due.filter((x) => x.state === 'expired').length;
  const first = due[0].entry;
  toast(expired
    ? t('{expired} Einträge abgelaufen, {soon} laufen bald ab – z. B. „{title}“', { expired, soon: due.length - expired, title: first.title })
    : t('{soon} Einträge laufen in den nächsten 30 Tagen ab – z. B. „{title}“ in {days} Tagen', { soon: due.length, title: first.title, days: daysUntil(first.expires) }), 'warn');
}

// Other modules read these bindings directly and change them through the setters (imports are read-only).
export function setExpiryReminded(value) { expiryReminded = value; return value; }
