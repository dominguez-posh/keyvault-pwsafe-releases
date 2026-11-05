// Entry icons and vault logos, loaded in the background.

import { avatar } from '../../../extension/core/dom.js';
import { call } from './ipc.js';
import { logos, st, ui } from './state.js';
import { splitKey } from './detail.js';
import { renderList } from './list.js';
import { renderSidebar } from './sidebar.js';

export const icons = new Map(); // item key → data URL (Key Vault lists only tags; icons are fetched on demand)
const iconQueue = [];
let iconWorkers = 0;

/** Loads entry icons of Key Vault entries in the background (4 at a time). */
function loadIcon(i, el) {
  iconQueue.push({ i, el });
  const next = async () => {
    const job = iconQueue.shift();
    if (!job) {
      iconWorkers--;
      return;
    }
    try {
      if (!icons.has(job.i.key)) {
        const [containerId, id] = splitKey(job.i.key);
        icons.set(job.i.key, (await call('item', containerId, id)).icon || '');
      }
      if (icons.get(job.i.key)) job.el.replaceWith(avatar(job.i.title, 'avatar', icons.get(job.i.key)));
    } catch {
      icons.set(job.i.key, '');
    }
    next();
  };
  while (iconWorkers < 4 && iconQueue.length) {
    iconWorkers++;
    next();
  }
}

export function itemAvatar(i) {
  const known = i.icon || icons.get(i.key);
  const el = avatar(i.title, 'avatar', known || '');
  if (!known && i.hasIcon && !icons.has(i.key)) loadIcon(i, el);
  return el;
}

/** The entry's icon or logo in a picker row (as in the list). */
export function smallAvatar(i) {
  const el = itemAvatar(i);
  el.classList.add('small');
  return el;
}

/** A Microsoft login among the list entries: marked so, or a Microsoft sign-in address. */
export const isMicrosoftSummary = (i) => i.type === 'login' && (!!i.msAdmin || (i.hosts || []).some((host) => /(^|\.)(microsoftonline|microsoft|office|azure)\.com$/.test(host)));

/** Logos of the visible containers; re-renders the sidebar once new ones arrived. */
export async function loadLogos() {
  const missing = st.containers.filter((c) => !c.locked && !c.error && !logos.has(c.id));
  if (!missing.length) return;
  await Promise.all(missing.map(async (c) => {
    logos.set(c.id, await call('containerLogo', c.id).catch(() => null));
  }));
  if (missing.some((c) => logos.get(c.id))) {
    renderSidebar();
    if (ui.containerId && missing.some((c) => c.id === ui.containerId)) renderList();
  }
}
