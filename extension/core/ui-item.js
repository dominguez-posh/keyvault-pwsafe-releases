// Item detail view and editor, shared by the extension popup and the desktop app.

import { h, icon, iconButton, formatDateTime, avatar, toast, modal } from './dom.js';
import { totpCode, parseTotp } from './totp.js';
import { generatePassword, passwordStrength, DEFAULT_OPTIONS } from './generator.js';
import { ITEM_TYPES, CERT_MAX_BYTES, FIELD_TYPES, FIELD_FILE_MAX_BYTES, normalizeItem, formatCardNumber, serverMethods, isMicrosoftLogin, DEVICE_KINDS, deviceOs, defaultPort, bastionUrlInTenant } from './model.js';
import { t } from './i18n.js';
import { hostFromUrl } from './match.js';
import { pickImage, ICON_MAX_CHARS } from './image.js';
import { expiryState } from './health.js';

/**
 * @param {object} item  parsed item
 * @param {{ copy: (text: string, label: string) => void, openUrl: (url: string) => void,
 *           containerName: (id: string) => string, actions?: Array<{ icon, label, onClick, danger?, primary? }>,
 *           onRemovePasskey?: (credentialId: string) => void }} ctx
 */
/** Admin centers of a Microsoft account: PIM ("activate a role") on top, then the centers grouped as tiles. */
function adminPanel(item, links) {
  // The colour as a custom property set in script (a style attribute would be blocked by the page's CSP).
  const logo = (l, size) => {
    const el = h('span', { class: 'admin-logo' }, icon(l.icon, size));
    if (l.color) el.style.setProperty('--c', l.color);
    return el;
  };
  const tile = (l) => h('button', { type: 'button', class: 'admin-link', dataset: { adminLink: l.id }, title: l.title || `${l.name} – ${t('öffnen und anmelden')}`, onclick: () => l.open(item) },
    logo(l, 16), h('span', { class: 'admin-text' }, h('b', {}, l.name), l.host ? h('small', {}, l.host) : null));
  // Product names stay as they are in every language.
  const groups = [{ id: 'identity', label: t('Identität & Sicherheit') }, { id: 'm365', label: 'Microsoft 365' }, { id: 'azure', label: 'Azure' }];
  const pim = links.find((l) => !l.group);
  return h('div', { class: 'field admin-panel' }, h('label', {}, t('Verwaltung')),
    pim ? h('button', { type: 'button', class: 'admin-link admin-pim', dataset: { adminLink: pim.id }, title: pim.title || pim.name, onclick: () => pim.open(item) },
      logo(pim, 18), h('span', { class: 'admin-text' }, h('b', {}, t('Rolle aktivieren')), h('small', {}, 'Privileged Identity Management')), icon('external', 15)) : null,
    ...groups.map(({ id, label }) => {
      const list = links.filter((l) => l.group === id);
      return list.length ? h('div', { class: 'admin-group', dataset: { adminGroup: id } }, h('div', { class: 'admin-group-title' }, label),
        h('div', { class: 'admin-tiles' }, ...list.map(tile))) : null;
    }));
}

export function itemDetail(item, ctx) {
  const rows = [];
  if (item.type === 'card') {
    const c = item.card;
    if (c.holder) rows.push(textField(t('Karteninhaber'), c.holder, ctx));
    if (c.number) rows.push(secretField(t('Kartennummer'), formatCardNumber(c.number), ctx, { masked: `•••• •••• •••• ${c.number.slice(-4)}`, copyValue: c.number }));
    if (c.expiry) rows.push(textField(t('Gültig bis'), c.expiry, ctx));
    if (c.cvc) rows.push(secretField(t('Prüfnummer (CVC)'), c.cvc, ctx));
    if (c.pin) rows.push(secretField(t('PIN'), c.pin, ctx));
  }
  if (item.type === 'certificate' && item.cert.data) rows.push(certificateField(item.cert, ctx));
  if (item.type === 'server') rows.push(...serverRows(item, ctx));
  // Desktop with admin tools on: PIM and the admin centers – one click opens it, signed in with this account.
  if (ctx.adminLinks?.length && isMicrosoftLogin(item)) rows.push(adminPanel(item, ctx.adminLinks));
  // Sophos login: one "open" button per portal (VPN, Admin, User portal …); the browser then fills the sign-in.
  if (item.type === 'login' && item.sophos && item.portals?.length) {
    rows.push(h('div', { class: 'field sophos-open' }, h('label', {}, t('Portale')),
      h('div', { class: 'field-row portal-buttons' }, ...item.portals.map((p) => h('button', { type: 'button', class: 'btn small portal-open', title: p.url,
        onclick: () => ctx.openUrl(p.url) }, icon('link', 14), t('{name} öffnen', { name: p.label || hostFromUrl(p.url) || p.url }))))));
  }
  // Login linked to another login: where the sign-in comes from (user name and password below are read from there –
  // the caller resolves them, see resolveLogin).
  if (item.type === 'login' && item.loginLink) {
    const l = item.linked;
    rows.push(h('div', { class: 'field login-linked' }, h('label', {}, t('Anmeldung über')),
      h('div', { class: 'field-row' }, h('span', { class: 'value linked' }, icon('link', 14), ' ',
        l && !l.missing ? [l.title, l.username].filter(Boolean).join(' · ') : t('Verknüpfter Eintrag (nicht verfügbar)')))));
  }
  if (item.username) rows.push(textField(t('Benutzername'), item.username, ctx));
  if (item.password) rows.push(secretField(item.type === 'certificate' ? t('Zertifikats-Passwort') : t('Passwort'), item.password, ctx));
  if (item.totp) rows.push(totpField(item.totp, ctx));
  if (item.urls.length) {
    rows.push(h('div', { class: 'field' }, h('label', {}, item.urls.length > 1 ? t('Websites') : t('Website')),
      ...item.urls.map((u) => h('div', { class: 'field-row' },
        h('a', { href: '#', class: 'url', title: u, onclick: (e) => { e.preventDefault(); ctx.openUrl(u); } }, u),
        iconButton('copy', t('Kopieren'), () => ctx.copy(u, t('Adresse')))))));
  }
  if (item.passkeys.length) rows.push(passkeyList(item.passkeys, ctx));
  for (const f of item.fields) rows.push(customField(f, ctx));
  if (item.notes) rows.push(h('div', { class: 'field' }, h('label', {}, t('Notizen')), h('div', { class: 'notes' }, item.notes)));

  // With ctx.menu (desktop): the actions sit in the head – main action as a button, "quick" ones as icons, the rest
  // behind "⋯". Without it (popup): the classic row of buttons below the fields.
  // Desktop: a quiet "⋯" beside the title with every action (menu on hover).
  const hoverMenu = ctx.menu && ctx.actions?.length ? itemHoverMenu(ctx) : null;
  return h('div', { class: 'item-detail' },
    h('div', { class: 'item-head' },
      avatar(item.title, 'avatar large', item.icon),
      h('div', { class: 'item-head-text' },
        h('h2', {}, item.favorite ? icon('star', 14) : null, item.title),
        h('div', { class: 'muted' }, [ctx.containerName(item.containerId), item.folder, t(item.type === 'server' ? DEVICE_KINDS[item.server.kind] : ITEM_TYPES[item.type]), item.msAdmin ? t('Microsoft-Admin') : '', item.sophos ? t('Sophos') : ''].filter(Boolean).join(' · ')),
        expiryBadge(item.expires)),
      hoverMenu),
    // Fields as one card with dividers (modern design); the action bar and meta line stay outside.
    rows.length ? h('div', { class: 'field-card' }, ...rows) : h('p', { class: 'muted' }, t('Keine Felder')),
    // Admin mode (#307): which assets and linked logins use this login.
    item.type === 'login' && ctx.showLinkedAssets ? h('div', { class: 'actions linked-assets-row' },
      h('button', { type: 'button', class: 'btn small linked-assets', onclick: () => ctx.showLinkedAssets(item) }, icon('link', 14), t('Verknüpfte Assets anzeigen'))) : null,
    h('div', { class: 'meta muted' }, item.updatedBy
      ? t('Geändert {date} von {user}', { date: formatDateTime(item.updated), user: item.updatedBy })
      : t('Geändert {date}', { date: formatDateTime(item.updated) })),
    !hoverMenu && ctx.actions?.length ? h('div', { class: 'actions' }, ...ctx.actions.map((a) => h('button', {
      type: 'button', class: a.danger ? 'btn danger' : a.primary ? 'btn primary' : 'btn', onclick: a.onClick,
    }, icon(a.icon), a.label))) : null);
}

/**
 * View "actions at the top": a quiet "⋯" next to the title; hovering (or clicking) opens one menu with every action –
 * the main one first, quick ones next, the rest below, deleting last.
 */
function itemHoverMenu(ctx) {
  const ordered = [...ctx.actions.filter((a) => a.primary), ...ctx.actions.filter((a) => a.quick && !a.primary), ...ctx.actions.filter((a) => !a.primary && !a.quick)];
  const items = [];
  ordered.forEach((a, i) => {
    const prev = ordered[i - 1];
    if (prev && ((prev.primary || prev.quick) && !a.primary && !a.quick || a.danger)) items.push('-');
    items.push({ action: a.action || '', icon: a.icon, label: a.label, danger: a.danger, onClick: a.onClick });
  });
  const b = iconButton('more', t('Aktionen'), (e) => ctx.menu(e.currentTarget, items, { below: true }));
  b.classList.add('item-hover-menu');
  b.setAttribute('aria-haspopup', 'menu');
  let timer = null;
  b.addEventListener('mouseenter', () => { timer = setTimeout(() => { if (!document.querySelector('.context-menu')) ctx.menu(b, items, { below: true }); }, 150); });
  b.addEventListener('mouseleave', () => clearTimeout(timer));
  return b;
}

/** "Gültig bis" with a warning when the date is near or past. */
export function expiryBadge(expires) {
  if (!expires) return null;
  const state = expiryState(expires);
  const date = new Date(`${expires}T12:00:00`).toLocaleDateString();
  if (state === 'expired') return h('span', { class: 'badge danger expiry' }, icon('clock', 11), t('Abgelaufen am {date}', { date }));
  if (state === 'soon') return h('span', { class: 'badge warn expiry' }, icon('clock', 11), t('Läuft ab am {date}', { date }));
  return h('span', { class: 'badge expiry' }, icon('clock', 11), t('Gültig bis {date}', { date }));
}

function textField(label, value, ctx) {
  return h('div', { class: 'field' }, h('label', {}, label),
    h('div', { class: 'field-row' }, h('span', { class: 'value' }, value), iconButton('copy', t('Kopieren'), () => ctx.copy(value, label))));
}

function secretField(label, value, ctx, { masked = '••••••••••••', copyValue = value } = {}) {
  const span = h('span', { class: 'value secret' }, masked);
  let shown = false;
  const toggle = iconButton('eye', t('Anzeigen'), () => {
    shown = !shown;
    span.textContent = shown ? value : masked;
    span.classList.toggle('revealed', shown);
    toggle.replaceChildren(icon(shown ? 'eyeOff' : 'eye'));
  });
  return h('div', { class: 'field' }, h('label', {}, label),
    h('div', { class: 'field-row' }, span, toggle, iconButton('copy', t('Kopieren'), () => ctx.copy(copyValue, label))));
}

const fileSize = (bytes) => (bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`);

function certificateField(cert, ctx) {
  return h('div', { class: 'field' }, h('label', {}, t('Zertifikat')),
    h('div', { class: 'field-row' },
      h('span', { class: 'value' }, icon('note', 14), ` ${cert.fileName || t('Zertifikat')} · ${fileSize(cert.size)}`),
      ctx.saveFile ? h('button', { type: 'button', class: 'btn small', onclick: () => ctx.saveFile(cert.fileName || 'zertifikat.pfx', cert.data) }, icon('download', 14), t('Speichern unter …')) : null));
}

const FIELD_ICONS = { text: 'note', hidden: 'lock', multiline: 'note', url: 'link', email: 'mail', phone: 'phone', number: 'key', date: 'clock', totp: 'clock', file: 'download' };

/** File for a field (small text files, notes, keys): base64 within FIELD_FILE_MAX_BYTES. */
async function readFieldFile(file) {
  if (file.size > FIELD_FILE_MAX_BYTES) throw new Error(t('Die Datei ist zu groß ({size} KB, maximal {max} KB).', { size: Math.ceil(file.size / 1024), max: FIELD_FILE_MAX_BYTES / 1024 }));
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { value: btoa(bin), fileName: file.name, mime: file.type || 'application/octet-stream', size: bytes.length, hidden: false };
}

/** Field in the detail view by type: link, e-mail, date, live one-time code, file with preview/save. */
function customField(f, ctx) {
  if (f.type === 'file') {
    const isText = /^text\/|json|xml|csv/.test(f.mime) || /\.(txt|md|csv|json|xml|log|ini|conf|cfg|yaml|yml)$/i.test(f.fileName);
    const text = () => new TextDecoder().decode(Uint8Array.from(atob(f.value), (c) => c.charCodeAt(0)));
    const preview = h('pre', { class: 'file-preview', hidden: true });
    return h('div', { class: 'field' }, h('label', {}, f.name || t('Datei')),
      h('div', { class: 'field-row' },
        h('span', { class: 'value' }, icon('download', 14), ` ${f.fileName} · ${fileSize(f.size)}`),
        isText ? iconButton('eye', t('Anzeigen'), () => { preview.textContent = text(); preview.hidden = !preview.hidden; }) : null,
        isText ? iconButton('copy', t('Inhalt kopieren'), () => ctx.copy(text(), f.name || f.fileName)) : null,
        ctx.saveFile ? h('button', { type: 'button', class: 'btn small', onclick: () => ctx.saveFile(f.fileName, f.value) }, icon('download', 14), t('Speichern unter …')) : null),
      preview);
  }
  if (f.type === 'totp' && f.value) return totpField(f.value, ctx, f.name);
  if (f.hidden || f.type === 'hidden') return secretField(f.name, f.value, ctx);
  if (f.type === 'multiline') {
    return h('div', { class: 'field' }, h('label', {}, f.name),
      h('div', { class: 'field-row' }, h('span', { class: 'value notes' }, f.value), iconButton('copy', t('Kopieren'), () => ctx.copy(f.value, f.name))));
  }
  if (f.type === 'url' && f.value) {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(f.value) ? f.value : `https://${f.value}`;
    return h('div', { class: 'field' }, h('label', {}, f.name),
      h('div', { class: 'field-row' }, h('a', { href: '#', class: 'url', title: url, onclick: (e) => { e.preventDefault(); ctx.openUrl(url); } }, f.value), iconButton('copy', t('Kopieren'), () => ctx.copy(f.value, f.name))));
  }
  if (f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(f.value)) return textField(f.name, new Date(`${f.value}T12:00:00`).toLocaleDateString(), ctx);
  return textField(f.name, f.value, ctx);
}

/** File → base64 (for certificates, within CERT_MAX_BYTES). */
async function readCertificate(file) {
  if (file.size > CERT_MAX_BYTES) throw new Error(t('Die Datei ist zu groß ({size} KB, maximal {max} KB).', { size: Math.ceil(file.size / 1024), max: CERT_MAX_BYTES / 1024 }));
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { fileName: file.name, data: btoa(bin), size: bytes.length };
}

function totpField(secret, ctx, label = t('Einmalcode (TOTP)')) {
  const code = h('span', { class: 'value totp' }, '––– –––');
  const ring = h('span', { class: 'totp-timer' });
  const el = h('div', { class: 'field' }, h('label', {}, label),
    h('div', { class: 'field-row' }, code, ring, iconButton('copy', t('Kopieren'), async () => {
      const c = await totpCode(secret).catch(() => null);
      if (c) ctx.copy(c.code, t('Einmalcode'));
    })));
  let config;
  try {
    config = parseTotp(secret);
  } catch (e) {
    code.textContent = e.message;
    return el;
  }
  const tick = async () => {
    if (!el.isConnected && el.dataset.started) {
      clearInterval(timer);
      return;
    }
    el.dataset.started = '1';
    const c = await totpCode(config);
    code.textContent = `${c.code.slice(0, Math.ceil(c.code.length / 2))} ${c.code.slice(Math.ceil(c.code.length / 2))}`;
    ring.textContent = String(c.remaining);
    ring.classList.toggle('low', c.remaining <= 5);
  };
  const timer = setInterval(tick, 1000);
  tick();
  return el;
}

/**
 * Server entry: where it is, the buttons to connect (desktop: ctx.connect) and which entries hold the accounts
 * (ctx.linkTitle names a linked entry; it stays a reference, the secret is read only when connecting).
 */
function serverRows(item, ctx) {
  const s = item.server;
  const rows = [];
  const methods = serverMethods(item);
  const os = deviceOs(s);
  const LABELS = { rdp: [t('Remotedesktop (RDP)'), 'external'], ssh: [t('SSH'), 'external'], teamviewer: [t('TeamViewer'), 'external'], bastion: [t('Bastion im Browser'), 'globe'], mgmt: [mgmtLabel(s.kind), 'globe'] };
  if (ctx.connect && methods.length) {
    rows.push(h('div', { class: 'field' }, h('label', {}, t('Verbinden')), h('div', { class: 'connect-row' },
      ...methods.map((m) => h('button', { type: 'button', class: 'btn small', dataset: { connect: m }, onclick: () => ctx.connect(item, m) }, icon(LABELS[m][1], 14), LABELS[m][0])))));
  }
  if (s.host) rows.push(textField(t('Server (IP oder Name)'), s.port && s.port !== defaultPort(os) ? `${s.host}:${s.port}` : s.host, ctx));
  const link = (label, key) => h('div', { class: 'field' }, h('label', {}, label),
    h('div', { class: 'field-row' }, h('span', { class: 'value linked' }, icon('link', 14), ' ', ctx.linkTitle?.(key) || t('Verknüpfter Eintrag'))));
  if (s.rdpLink) rows.push(link(os === 'linux' ? t('SSH-Konto') : t('RDP-Konto'), s.rdpLink));
  if (s.tvId) rows.push(textField(t('TeamViewer-ID'), s.tvId, ctx));
  if (s.tvLink) rows.push(link(t('TeamViewer-Passwort'), s.tvLink));
  else if (s.tvPassword) rows.push(secretField(t('TeamViewer-Passwort'), s.tvPassword, ctx));
  if (s.bastionUrl) {
    rows.push(h('div', { class: 'field' }, h('label', {}, t('Bastion-Link')), h('div', { class: 'field-row' },
      h('a', { href: '#', class: 'url', title: s.bastionUrl, onclick: (e) => { e.preventDefault(); ctx.openUrl(bastionUrlInTenant(s.bastionUrl, s.bastionTenant)); } }, s.bastionUrl),
      iconButton('copy', t('Kopieren'), () => ctx.copy(bastionUrlInTenant(s.bastionUrl, s.bastionTenant), t('Adresse'))))));
    if (s.bastionTenant) rows.push(h('div', { class: 'field' }, h('label', {}, t('Microsoft-Tenant')), h('div', { class: 'field-row' }, h('span', { class: 'value' }, s.bastionTenant))));
  }
  if (s.mgmtUrl) {
    rows.push(h('div', { class: 'field' }, h('label', {}, t('Verwaltungsseite')), h('div', { class: 'field-row' },
      h('a', { href: '#', class: 'url', title: s.mgmtUrl, onclick: (e) => { e.preventDefault(); ctx.openUrl(s.mgmtUrl); } }, s.mgmtUrl),
      iconButton('copy', t('Kopieren'), () => ctx.copy(s.mgmtUrl, t('Adresse'))))));
  }
  if (s.bastionLoginLink) rows.push(link(t('Microsoft-Anmeldung (Bastion)'), s.bastionLoginLink));
  if (s.bastionVmLink) rows.push(link(t('Konto auf dem Server (Bastion)'), s.bastionVmLink));
  return rows;
}

/** Button text of a device's management page by kind. */
function mgmtLabel(kind) {
  if (kind === 'vmware') return t('vSphere-Client');
  if (kind === 'hyperv') return t('Windows Admin Center');
  return t('Verwaltungsseite');
}

function passkeyList(passkeys, ctx) {
  return h('div', { class: 'field' }, h('label', {}, passkeys.length > 1 ? t('Passkeys') : t('Passkey')),
    ...passkeys.map((p) => h('div', { class: 'passkey-row', ...(ctx.passkeyDrag ? {
      draggable: 'true', title: t('Auf einen anderen Login in der Liste ziehen, um den Passkey dorthin zu verschieben'),
      ondragstart: (e) => ctx.passkeyDrag(e, p), ondragend: () => ctx.passkeyDragEnd?.() } : {}) },
      icon('key'),
      h('div', { class: 'passkey-text' },
        h('div', {}, p.userName || p.userDisplayName || t('(ohne Benutzername)')),
        h('div', { class: 'muted small' }, t('{rpId} · erstellt {date}', { rpId: p.rpId, date: formatDateTime(p.created) }))),
      ctx.onMovePasskey ? iconButton('move', t('In anderen Eintrag verschieben'), () => ctx.onMovePasskey(p)) : null,
      ctx.onRemovePasskey ? iconButton('trash', t('Passkey entfernen'), () => ctx.onRemovePasskey(p.credentialId)) : null)));
}

const secretInputEl = (name, value) => h('input', { name, type: 'password', value, autocomplete: 'off', spellcheck: 'false' });
function revealButton(input) {
  const b = iconButton('eye', t('Anzeigen'), () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    b.replaceChildren(icon(input.type === 'password' ? 'eye' : 'eyeOff'));
  });
  return b;
}

/**
 * Filters above a picker list (#312): range "Current vault" (default) or "All", and kinds – all, Microsoft logins,
 * with passkey, admin accounts. Options carry { microsoft, passkey, msAdmin }. → { el, state: { all, kind } }
 */
const PICK_KINDS = [['all', 'Alle'], ['microsoft', 'Microsoft'], ['passkey', 'Mit Passkey'], ['admin', 'Admin']];
export function pickFilterBar({ scope = true, onChange }) {
  const state = { all: false, kind: 'all' };
  const seg = (key, choices, label) => {
    const box = h('span', { class: 'seg pick-seg', role: 'radiogroup', 'aria-label': label, dataset: { filter: key } });
    const draw = () => box.replaceChildren(...choices.map(([value, text]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(state[key] === value), class: state[key] === value ? 'on' : '', dataset: { value: String(value) },
      onclick: () => { state[key] = value; draw(); onChange(); },
    }, t(text))));
    draw();
    return box;
  };
  const el = h('div', { class: 'pick-filters' },
    scope ? seg('all', [[false, 'Aktueller Tresor'], [true, 'Alle']], t('Bereich')) : null,
    seg('kind', PICK_KINDS, t('Art')));
  return { el, state };
}
export const pickKindMatches = (o, kind) => kind === 'all' || (kind === 'microsoft' && o.microsoft) || (kind === 'passkey' && o.passkey) || (kind === 'admin' && o.msAdmin);

/**
 * Item editor.
 * @param {object} item  item to edit (or {} for a new one)
 * @param {{ containers: Array<{ id, name }>, containerId?: string, isNew: boolean,
 *           onSave: (item: object, containerId: string) => Promise<void>, onCancel: () => void }} ctx
 */
export function itemForm(item, ctx) {
  const it = normalizeItem(item);
  const containerSelect = h('select', { name: 'container', disabled: !ctx.isNew },
    ...ctx.containers.map((c) => h('option', { value: c.id, selected: c.id === ctx.containerId }, c.name)));
  // The type is fixed once the entry exists (#263): another type would drop its fields (server, card, certificate).
  const typeSelect = h('select', { name: 'type', disabled: !ctx.isNew, title: ctx.isNew ? '' : t('Der Typ lässt sich nach dem Anlegen nicht mehr ändern.') },
    ...Object.entries(ITEM_TYPES).filter(([k]) => k !== 'server' || ctx.devices || it.type === 'server')
      .map(([k, label]) => h('option', { value: k, selected: k === it.type }, t(label))));
  const title = h('input', { name: 'title', value: item.title || '', placeholder: t('z. B. GitHub'), required: true, autocomplete: 'off' });
  const username = h('input', { name: 'username', value: it.username, autocomplete: 'off', spellcheck: 'false' });
  const password = h('input', { name: 'password', type: 'password', value: it.password, autocomplete: 'new-password', spellcheck: 'false' });
  const meter = h('div', { class: 'strength' }, h('span'), h('em'));
  const updateMeter = () => {
    const s = passwordStrength(password.value);
    meter.dataset.level = String(s.level);
    meter.querySelector('em').textContent = s.label ? t('{label} ({bits} Bit)', { label: s.label, bits: s.bits }) : '';
  };
  password.addEventListener('input', updateMeter);
  const reveal = iconButton('eye', t('Anzeigen'), () => {
    password.type = password.type === 'password' ? 'text' : 'password';
    reveal.replaceChildren(icon(password.type === 'password' ? 'eye' : 'eyeOff'));
  });
  const generator = generatorPanel({ ...DEFAULT_OPTIONS }, (pw) => {
    password.value = pw;
    password.type = 'text';
    updateMeter();
  });
  generator.hidden = true;
  const genButton = iconButton('wand', t('Passwort generieren'), () => {
    if (generator.hidden) generator.regenerate();
    generator.hidden = !generator.hidden;
  });
  const urls = h('textarea', { name: 'urls', rows: 2, placeholder: t('https://example.com (eine pro Zeile)'), value: it.urls.join('\n'), spellcheck: 'false' });
  // Sophos login: named portals (VPN, Admin, User portal …) as free rows – name and address each free to type.
  const sophos = h('input', { type: 'checkbox', name: 'sophos', checked: it.sophos });
  const portalRows = h('div', { class: 'portal-rows' });
  const portalRow = (p = { label: '', url: '' }) => {
    const row = h('div', { class: 'field-row portal-row' },
      h('input', { class: 'portal-label', value: p.label, placeholder: t('Name, z. B. VPN-Portal'), autocomplete: 'off' }),
      h('input', { class: 'portal-url', value: p.url, placeholder: 'https://vpn.example.com', autocomplete: 'off', spellcheck: 'false' }));
    row.append(iconButton('x', t('Entfernen'), () => row.remove()));
    portalRows.append(row);
  };
  const seedPortals = it.portals.length ? it.portals : (item.portals || []);
  (seedPortals.length ? seedPortals : [{ label: t('VPN-Portal'), url: '' }, { label: t('Admin-Portal'), url: '' }]).forEach((p) => portalRow(p));
  const portalBox = h('div', { class: 'field sophos-portals' }, h('label', {}, t('Portale')), portalRows,
    h('button', { type: 'button', class: 'btn small portal-add', onclick: () => portalRow() }, icon('plus', 14), t('Portal hinzufügen')),
    h('div', { class: 'muted small' }, t('Mit Einmalcode (MFA) trägt Keevault beim Ausfüllen im Browser Passwort und Code direkt hintereinander ins Passwortfeld ein. Kopieren in der App liefert nur das Passwort.')));
  const urlsRow = row(t('Websites'), urls);
  const syncSophos = () => {
    portalBox.hidden = !sophos.checked;
    urlsRow.hidden = sophos.checked;
  };
  sophos.addEventListener('change', syncSophos);
  const collectPortals = () => [...portalRows.querySelectorAll('.portal-row')]
    .map((r) => ({ label: r.querySelector('.portal-label').value, url: r.querySelector('.portal-url').value }))
    .filter((p) => p.url.trim());
  // The TOTP secret is as sensitive as the password: hidden unless revealed.
  const totp = h('input', { name: 'totp', type: 'password', value: it.totp, placeholder: t('otpauth://… oder Base32-Geheimnis'), autocomplete: 'off', spellcheck: 'false' });
  const revealTotp = iconButton('eye', t('Anzeigen'), () => {
    totp.type = totp.type === 'password' ? 'text' : 'password';
    revealTotp.replaceChildren(icon(totp.type === 'password' ? 'eye' : 'eyeOff'));
  });
  // ctx.scanQr() (browser extension): reads the QR code the website shows when setting up two-factor sign-in.
  const scanTotp = ctx.scanQr ? iconButton('qr', t('QR-Code auf der Seite scannen'), async () => {
    scanTotp.disabled = true;
    try {
      const text = await ctx.scanQr();
      if (!text) {
        toast(t('Kein QR-Code auf der sichtbaren Seite gefunden. Bitte den QR-Code ins Bild holen und erneut scannen.'), 'error');
        return;
      }
      try {
        parseTotp(text); // throws when it is neither an otpauth:// link nor a Base32 secret
      } catch {
        toast(t('Der QR-Code auf der Seite enthält keinen Einmalcode (otpauth://).'), 'error');
        return;
      }
      totp.value = text;
      toast(t('Einmalcode aus QR-Code übernommen'));
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      scanTotp.disabled = false;
    }
  }) : null;
  const startFolder = it.folder || (ctx.isNew && ctx.defaultFolder) || '';
  // folderFree false: the vault's admin has not enabled creating folders – choose among existing ones only.
  const folder = ctx.folderFree === false
    ? h('select', { name: 'folder' },
      h('option', { value: '' }, t('Ohne Ordner')),
      ...[...new Set([...(ctx.folders || []), startFolder].filter(Boolean))].sort().map((f) => h('option', { value: f, selected: f === startFolder }, f)))
    : h('input', { name: 'folder', value: startFolder, placeholder: t('optional, z. B. Kunden/Contoso'), list: 'folder-options' });
  const folderOptions = h('datalist', { id: 'folder-options' }, ...(ctx.folders || []).map((f) => h('option', { value: f })));
  const favorite = h('input', { type: 'checkbox', name: 'favorite', checked: it.favorite });
  const expires = h('input', { type: 'date', name: 'expires', value: it.expires });
  let icon64 = it.icon;
  const iconPreview = h('span', {});
  const iconRemove = h('button', { type: 'button', class: 'btn small', onclick: () => { icon64 = ''; drawIcon(); } }, t('Entfernen'));
  // The open website's own icon for an entry without one (#314) – offered by the browser extension when the tab is one
  // of the entry's sites.
  const iconFromSite = ctx.siteIcon ? h('button', { type: 'button', class: 'btn small site-icon', onclick: async () => {
    const url = await ctx.siteIcon().catch(() => '');
    if (!url) return toast(t('Die Website hat kein passendes Symbol'), 'error');
    icon64 = url;
    return drawIcon();
  } }, t('Icon der Website übernehmen')) : null;
  const drawIcon = () => {
    iconPreview.replaceChildren(avatar(title.value || it.title, 'avatar', icon64));
    iconRemove.hidden = !icon64;
    if (iconFromSite) iconFromSite.hidden = !!icon64;
  };
  const iconChoose = h('button', { type: 'button', class: 'btn small', onclick: async () => {
    try {
      const url = await pickImage({ size: 64, maxChars: ICON_MAX_CHARS });
      if (url) {
        icon64 = url;
        drawIcon();
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  } }, t('Bild wählen …'));
  drawIcon();
  const notes = h('textarea', { name: 'notes', rows: 4, value: it.notes });

  const fields = it.fields.map((f) => ({ ...f }));
  const fieldsBox = h('div', { class: 'custom-fields' });
  // Input per field type; a file row shows name and size with "choose" and a size check (FIELD_FILE_MAX_BYTES).
  const valueInput = (f, i) => {
    const set = (e) => { fields[i].value = e.target.value; };
    if (f.type === 'multiline') return h('textarea', { rows: 3, value: f.value, placeholder: t('Wert'), oninput: set, spellcheck: 'false' });
    if (f.type === 'file') {
      const picker = h('input', { type: 'file', hidden: true, onchange: async () => {
        const file = picker.files?.[0];
        picker.value = '';
        if (!file) return;
        try {
          Object.assign(fields[i], await readFieldFile(file));
          if (!fields[i].name) fields[i].name = file.name;
          renderFields();
        } catch (err) {
          toast(err.message, 'error');
        }
      } });
      return h('div', { class: 'field-row' },
        h('span', { class: 'muted small file-info' }, f.value ? `${f.fileName} · ${fileSize(f.size)}` : t('Keine Datei (bis {max} KB)', { max: FIELD_FILE_MAX_BYTES / 1024 })),
        h('button', { type: 'button', class: 'btn small', onclick: () => picker.click() }, icon('upload', 14), f.value ? t('Ersetzen …') : t('Datei wählen …')), picker);
    }
    const types = { hidden: 'password', url: 'url', email: 'email', phone: 'tel', number: 'text', date: 'date', totp: 'password' };
    const placeholder = { url: 'https://…', email: 'name@firma.de', phone: '+49 …', totp: t('otpauth://… oder Base32-Geheimnis') }[f.type] || t('Wert');
    return h('input', { value: f.value, placeholder, type: types[f.type] || 'text', inputmode: f.type === 'number' ? 'numeric' : undefined, oninput: set, autocomplete: 'off', spellcheck: 'false' });
  };
  const renderFields = () => {
    fieldsBox.replaceChildren(...fields.map((f, i) => h('div', { class: `custom-field type-${f.type || 'text'}` },
      h('div', { class: 'field-row' },
        h('span', { class: 'field-type', title: t(FIELD_TYPES[f.type] || 'Text') }, icon(FIELD_ICONS[f.type] || 'note', 14)),
        h('input', { value: f.name, placeholder: t('Name'), oninput: (e) => { fields[i].name = e.target.value; } }),
        iconButton('x', t('Feld entfernen'), () => { fields.splice(i, 1); renderFields(); })),
      valueInput(f, i))));
  };
  renderFields();
  // "Add field": types and ready-made fields with a sensible name and type.
  const addMenu = h('div', { class: 'field-menu', hidden: true });
  const addField = (field) => {
    fields.push({ name: '', value: '', hidden: false, type: 'text', ...field });
    addMenu.hidden = true;
    renderFields();
    fieldsBox.lastElementChild?.querySelector(field.name ? 'textarea, input:not([type=file]):not(:first-of-type)' : 'input')?.focus();
  };
  const presets = [
    [t('Benutzername 2'), 'text'], [t('Lizenzschlüssel'), 'hidden'], [t('API-Schlüssel'), 'hidden'], [t('Wiederherstellungscodes'), 'multiline'],
    [t('PIN'), 'number'], [t('Sicherheitsfrage'), 'text'], [t('Antwort'), 'hidden'], [t('IP-Adresse / Hostname'), 'text'],
    [t('Kundennummer'), 'text'], [t('Ansprechpartner'), 'text'], [t('Support-Telefon'), 'phone'], [t('Support-E-Mail'), 'email'],
    [t('Admin-Portal'), 'url'], [t('Vertragsende'), 'date'], [t('SSH-Schlüssel'), 'multiline'], [t('Anhang (Datei)'), 'file'],
  ];
  addMenu.append(
    h('div', { class: 'field-menu-group' }, t('Feldtyp')),
    h('div', { class: 'field-menu-grid' }, ...Object.entries(FIELD_TYPES).map(([type, label]) => h('button', { type: 'button', onclick: () => addField({ type, hidden: type === 'hidden' }) }, icon(FIELD_ICONS[type], 14), t(label)))),
    h('div', { class: 'field-menu-group' }, t('Vorlagen')),
    h('div', { class: 'field-menu-grid' }, ...presets.map(([name, type]) => h('button', { type: 'button', onclick: () => addField({ name, type, hidden: type === 'hidden' }) }, icon(FIELD_ICONS[type], 14), name))));

  let passkeys = it.passkeys;
  const passkeyBox = h('div');
  const renderPasskeys = () => {
    passkeyBox.replaceChildren(...(passkeys.length ? [h('label', {}, t('Passkeys')), ...passkeys.map((p) => h('div', { class: 'passkey-row' },
      icon('key'),
      h('div', { class: 'passkey-text' }, h('div', {}, p.userName || t('(ohne Benutzername)')), h('div', { class: 'muted small' }, p.rpId)),
      iconButton('trash', t('Passkey entfernen'), () => { passkeys = passkeys.filter((x) => x !== p); renderPasskeys(); })))] : []));
  };
  renderPasskeys();

  // Logins: marker for Microsoft admin accounts (offered by the admin tools for admin centers and Bastion).
  const msAdmin = h('input', { type: 'checkbox', name: 'msAdmin', checked: it.msAdmin });

  // Server: links to other entries are a select over ctx.linkOptions (desktop); without them (popup) the stored
  // links are kept as they are. A link the user cannot see any more stays selected as "not available".
  // Linked entry: a field showing the choice; a click opens a window with search over title, user name and vault –
  // a plain drop-down is unusable with hundreds of entries. The element carries .value and fires "change" like a select.
  // Only entries of the device's own vault: whoever can read the device can read its accounts – a link into another
  // vault would hand them to people without access there (and break for everyone else).
  const sameVault = (options) => (options || []).filter((o) => !o.containerId || o.containerId === containerSelect.value);
  const linkPickers = [];
  // The entry's own icon or logo when the app provides it (as in its list), else the letter avatar.
  const pickAvatar = (o) => {
    const el = o.avatar ? o.avatar() : avatar(o.title, 'avatar');
    el.classList.add('small');
    return el;
  };
  const linkSelect = (name, value, emptyLabel, allOptions = ctx.linkOptions) => {
    if (!allOptions) return h('input', { type: 'hidden', name, value });
    let options = sameVault(allOptions);
    let current = value || '';
    const label = h('span', { class: 'link-pick-text' });
    const sub = h('span', { class: 'link-pick-sub' });
    const field = h('button', { type: 'button', class: 'link-pick', dataset: { name }, 'aria-haspopup': 'dialog' },
      icon('link', 14), h('span', { class: 'link-pick-main' }, label, sub), icon('search', 14));
    const draw = () => {
      const o = options.find((x) => x.key === current);
      label.textContent = !current ? emptyLabel : o ? o.title : t('Verknüpfter Eintrag (nicht verfügbar)');
      sub.textContent = o ? [o.username, o.container].filter(Boolean).join(' · ') : '';
      sub.hidden = !sub.textContent;
      field.classList.toggle('empty', !current);
    };
    const choose = (key) => {
      current = key;
      draw();
      field.dispatchEvent(new Event('change'));
    };
    Object.defineProperty(field, 'value', { get: () => current, set: (v) => { current = v || ''; draw(); } });
    // Another vault chosen for a new device: offer its entries, drop a link that pointed into the old one.
    linkPickers.push(() => {
      options = sameVault(allOptions);
      if (current && !options.some((o) => o.key === current)) choose('');
      else draw();
    });
    field.addEventListener('click', () => {
      const search = h('input', { type: 'search', class: 'link-pick-search', placeholder: t('Eintrag suchen (Titel, Benutzer, Tresor) …'), 'aria-label': t('Eintrag suchen') });
      const list = h('div', { class: 'link-pick-list', role: 'listbox' });
      const row = (key, title, detail, extra) => h('button', { type: 'button', role: 'option', class: `link-pick-row ${key === current ? 'on' : ''}`, 'aria-selected': String(key === current),
        onclick: () => { choose(key); close(); } },
      extra, h('span', { class: 'link-pick-main' }, h('span', { class: 'link-pick-text' }, title), detail ? h('span', { class: 'link-pick-sub' }, detail) : null),
      key === current ? icon('check', 14) : null);
      const LIMIT = 200;
      // "Current vault" by default; "All" shows the other vaults' entries too – greyed out, links stay in one vault.
      const filters = pickFilterBar({ onChange: () => fill() });
      const linkable = new Set(options.map((o) => o.key));
      const fill = () => {
        const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const pool = filters.state.all ? (allOptions || []) : options;
        const hits = pool.filter((o) => pickKindMatches(o, filters.state.kind) && words.every((w) => [o.title, o.username, o.container].join(' ').toLowerCase().includes(w)));
        list.replaceChildren(...[
          words.length || filters.state.kind !== 'all' ? null : row('', emptyLabel, '', h('span', { class: 'link-pick-none' }, icon('x', 14))),
          ...hits.slice(0, LIMIT).map((o) => {
            const r = row(o.key, o.title, [o.username, o.container].filter(Boolean).join(' · '), pickAvatar(o));
            if (!linkable.has(o.key)) {
              r.disabled = true;
              r.title = t('Nur Einträge aus demselben Tresor lassen sich verknüpfen.');
            }
            return r;
          }),
          hits.length ? null : h('p', { class: 'muted small link-pick-empty' }, t('Kein Eintrag gefunden.')),
          hits.length > LIMIT ? h('p', { class: 'muted small link-pick-empty' }, t('{count} weitere – Suche verfeinern', { count: hits.length - LIMIT })) : null].filter(Boolean));
      };
      search.addEventListener('input', fill);
      search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        list.querySelector('.link-pick-row')?.click();
      });
      fill();
      const { close } = modal(t('Eintrag verknüpfen'), h('div', { class: 'link-pick-dialog' }, search, filters.el, list), [{ label: t('Abbrechen') }]);
      setTimeout(() => search.focus(), 0);
    });
    draw();
    return field;
  };
  const sv = it.server;
  const srvKind = h('select', { name: 'srvKind' }, ...Object.entries(DEVICE_KINDS).map(([k, label]) => h('option', { value: k, selected: k === sv.kind }, t(label))));
  const srvHost = h('input', { name: 'srvHost', value: sv.host, placeholder: t('z. B. 10.0.0.4 oder dc01.contoso.local'), autocomplete: 'off', spellcheck: 'false' });
  const srvPort = h('input', { name: 'srvPort', value: String(sv.port || defaultPort(sv.os)), inputmode: 'numeric', autocomplete: 'off' });
  const srvOs = h('select', { name: 'srvOs' }, h('option', { value: 'windows', selected: sv.os !== 'linux' }, t('Windows (RDP)')), h('option', { value: 'linux', selected: sv.os === 'linux' }, t('Linux (SSH)')));
  const srvMgmt = h('input', { name: 'srvMgmt', value: sv.mgmtUrl, placeholder: 'https://vcenter.contoso.local', autocomplete: 'off', spellcheck: 'false' });
  const srvRdpLink = linkSelect('srvRdpLink', sv.rdpLink, t('Eigener Benutzer und Passwort'));
  const srvUser = h('input', { name: 'srvUser', value: it.type === 'server' ? it.username : '', placeholder: 'DOMAIN\\user · user@domain', autocomplete: 'off', spellcheck: 'false' });
  const srvPass = secretInputEl('srvPass', it.type === 'server' ? it.password : '');
  const srvOwn = h('div', { class: 'grid2' }, row(t('Benutzer'), srvUser), row(t('Passwort'), h('div', { class: 'field-row' }, srvPass, revealButton(srvPass))));
  const srvTvId = h('input', { name: 'srvTvId', value: sv.tvId, inputmode: 'numeric', placeholder: '123 456 789', autocomplete: 'off' });
  const srvTvLink = linkSelect('srvTvLink', sv.tvLink, t('Eigenes Passwort'));
  const srvTvPass = secretInputEl('srvTvPass', sv.tvPassword);
  const srvTvOwn = row(t('TeamViewer-Passwort'), h('div', { class: 'field-row' }, srvTvPass, revealButton(srvTvPass)));
  const srvBastion = h('input', { name: 'srvBastion', value: sv.bastionUrl, placeholder: t('Link aus dem Azure-Portal oder Bastion-Freigabelink'), autocomplete: 'off', spellcheck: 'false' });
  const adminOptions = ctx.linkOptions && [...ctx.linkOptions].sort((a, b) => Number(!!b.msAdmin) - Number(!!a.msAdmin));
  const srvBastionLogin = linkSelect('srvBastionLogin', sv.bastionLoginLink, t('Keine – im Browser selbst anmelden'), adminOptions);
  const srvBastionVm = linkSelect('srvBastionVm', sv.bastionVmLink, t('Wie bei RDP'));
  const srvBastionTenant = h('input', { name: 'srvBastionTenant', value: sv.bastionTenant || '', placeholder: t('z. B. contoso.com oder Tenant-ID'), autocomplete: 'off', spellcheck: 'false' });
  // Empty: taken from the Microsoft sign-in's domain once one is chosen (alex@contoso.com → contoso.com).
  srvBastionLogin.addEventListener?.('change', () => {
    if (srvBastionTenant.value.trim()) return;
    const o = (ctx.linkOptions || []).find((x) => x.key === srvBastionLogin.value);
    const domain = String(o?.username || '').split('@')[1];
    if (domain) srvBastionTenant.value = domain.toLowerCase();
  });
  const syncServer = () => {
    srvOwn.hidden = !!srvRdpLink.value;
    srvTvOwn.hidden = !!srvTvLink.value;
  };
  // The kind decides what the form asks for: RDP or SSH (port and account label), Bastion only for Azure VMs, the
  // management page for VMware, Hyper-V and other devices. Data already entered stays visible.
  const osRow = row(t('Betriebssystem'), srvOs);
  const portLabel = h('label', {}, '');
  const accountLabel = h('label', {}, '');
  const mgmtLabelEl = h('label', {}, '');
  const mgmtRow = h('div', { class: 'field' }, mgmtLabelEl, srvMgmt);
  let shownOs = sv.os;
  const syncKind = () => {
    const kind = srvKind.value;
    osRow.hidden = kind === 'windows' || kind === 'linux';
    const os = deviceOs({ kind, os: srvOs.value });
    if (os !== shownOs && srvPort.value.trim() === String(defaultPort(shownOs))) srvPort.value = String(defaultPort(os));
    shownOs = os;
    portLabel.textContent = os === 'linux' ? t('SSH-Port') : t('RDP-Port');
    accountLabel.textContent = os === 'linux' ? t('SSH-Konto') : t('RDP-Konto');
    mgmtLabelEl.textContent = kind === 'vmware' ? t('vSphere-Client / vCenter (Adresse)') : kind === 'hyperv' ? t('Windows Admin Center (Adresse)') : t('Verwaltungsseite (Adresse)');
    mgmtRow.hidden = !['vmware', 'hyperv', 'other'].includes(kind) && !srvMgmt.value;
    bastionBox.hidden = kind !== 'azurevm' && !srvBastion.value;
  };
  srvRdpLink.addEventListener?.('change', syncServer);
  srvTvLink.addEventListener?.('change', syncServer);
  syncServer();
  containerSelect.addEventListener('change', () => linkPickers.forEach((refresh) => refresh()));
  const bastionBox = h('div', {},
    row(t('Bastion-Link'), srvBastion),
    h('div', { class: 'grid2' }, row(t('Microsoft-Anmeldung (Bastion)'), srvBastionLogin), row(t('Konto auf dem Server (Bastion)'), srvBastionVm)),
    row(t('Microsoft-Tenant'), srvBastionTenant));
  srvKind.addEventListener('change', syncKind);
  srvOs.addEventListener('change', syncKind);
  syncKind();
  const serverOnly = h('div', { class: 'server-only' },
    row(t('Asset-Typ'), srvKind), osRow,
    h('div', { class: 'grid2 server-host' }, row(t('Server (IP oder Name)'), srvHost), h('div', { class: 'field' }, portLabel, srvPort)),
    h('div', { class: 'field' }, accountLabel, srvRdpLink), srvOwn,
    mgmtRow,
    h('div', { class: 'grid2' }, row(t('TeamViewer-ID'), srvTvId), row(t('TeamViewer-Passwort aus'), srvTvLink)), srvTvOwn,
    bastionBox,
    h('p', { class: 'muted small' }, t('Verknüpfte Einträge bleiben, wo sie sind – Keevault liest sie erst beim Verbinden.')));

  // Login: user name and password from another login of this vault (domain login, Microsoft login for a portal that
  // signs in with Microsoft) instead of own ones. Not the entry itself, not a login that is linked itself (one level).
  const loginOptions = ctx.linkOptions && ctx.linkOptions.filter((o) => o.key !== `${item.containerId}/${item.id}` && !o.loginLinked)
    .sort((a, b) => Number(!!b.msAdmin) - Number(!!a.msAdmin));
  const loginLink = linkSelect('loginLink', it.loginLink, t('Eigener Benutzername und eigenes Passwort'), loginOptions);
  const ownLogin = h('div', { class: 'own-login' },
    row(t('Benutzername'), username),
    h('div', { class: 'field' }, h('label', {}, t('Passwort')), h('div', { class: 'field-row' }, password, reveal, genButton), meter, generator));
  const syncLoginLink = () => { ownLogin.hidden = !!loginLink.value; };
  loginLink.addEventListener('change', syncLoginLink);
  syncLoginLink();
  const loginOnly = h('div', { class: 'login-only' },
    loginOptions || it.loginLink ? h('div', { class: 'field login-link' }, h('label', {}, t('Anmeldung')), loginLink,
      h('div', { class: 'muted small' }, t('Z. B. den Domain-Login oder bei Portalen mit Microsoft-Anmeldung den Microsoft-Login wählen – Benutzername und Passwort kommen dann von dort.'))) : null,
    ownLogin,
    urlsRow,
    row(t('Einmalcode (TOTP)'), h('div', { class: 'field-row' }, totp, revealTotp, scanTotp)),
    h('label', { class: 'inline' }, msAdmin, t('Microsoft-Admin-Konto (für Admin Center und Bastion)')),
    h('label', { class: 'inline' }, sophos, t('Sophos-Login (Portale, bei MFA Passwort + Einmalcode zusammen)')),
    portalBox,
    passkeyBox);
  // Credit card
  const secretInput = (name, value, extra = {}) => h('input', { name, type: 'password', value, autocomplete: 'off', spellcheck: 'false', ...extra });
  const revealFor = (input) => {
    const b = iconButton('eye', t('Anzeigen'), () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      b.replaceChildren(icon(input.type === 'password' ? 'eye' : 'eyeOff'));
    });
    return b;
  };
  const cardHolder = h('input', { name: 'cardHolder', value: it.card.holder, autocomplete: 'off', placeholder: t('Name wie auf der Karte') });
  const cardNumber = secretInput('cardNumber', formatCardNumber(it.card.number), { inputmode: 'numeric', placeholder: '1234 5678 9012 3456' });
  const cardExpiry = h('input', { name: 'cardExpiry', value: it.card.expiry, autocomplete: 'off', placeholder: t('MM/JJ') });
  const cardCvc = secretInput('cardCvc', it.card.cvc, { inputmode: 'numeric', maxlength: '4' });
  const cardPin = secretInput('cardPin', it.card.pin, { inputmode: 'numeric', maxlength: '12' });
  const cardOnly = h('div', { class: 'card-only' },
    row(t('Karteninhaber'), cardHolder),
    row(t('Kartennummer'), h('div', { class: 'field-row' }, cardNumber, revealFor(cardNumber))),
    h('div', { class: 'grid2' },
      row(t('Gültig bis'), cardExpiry),
      row(t('Prüfnummer (CVC)'), h('div', { class: 'field-row' }, cardCvc, revealFor(cardCvc)))),
    row(t('PIN'), h('div', { class: 'field-row' }, cardPin, revealFor(cardPin))));

  // Certificate: file inside the item, plus its password
  let cert = it.cert.data ? { ...it.cert } : null;
  const certInfo = h('span', { class: 'value' });
  const certFile = h('input', { type: 'file', accept: '.pfx,.p12,.cer,.crt,.pem,.der,.p7b,.key', hidden: true });
  const drawCert = () => certInfo.replaceChildren(cert ? `${cert.fileName} · ${fileSize(cert.size)}` : t('Keine Datei gewählt'));
  certFile.addEventListener('change', async () => {
    const file = certFile.files?.[0];
    if (!file) return;
    try {
      cert = await readCertificate(file);
      if (!title.value.trim()) title.value = file.name.replace(/\.[^.]+$/, '');
      drawCert();
    } catch (e) {
      toast(e.message, 'error');
    }
    certFile.value = '';
  });
  drawCert();
  const certPassword = secretInput('certPassword', it.type === 'certificate' ? it.password : '', { autocomplete: 'new-password' });
  const certOnly = h('div', { class: 'cert-only' },
    h('div', { class: 'field' }, h('label', {}, t('Zertifikatsdatei')),
      h('div', { class: 'field-row' }, certInfo, h('button', { type: 'button', class: 'btn small', onclick: () => certFile.click() }, icon('upload', 14), t('Datei wählen …')), certFile),
      h('div', { class: 'muted small' }, t('PFX/P12, CER/CRT, PEM oder DER – bis {max} KB. Die Datei wird im Tresor gespeichert.', { max: CERT_MAX_BYTES / 1024 }))),
    row(t('Zertifikats-Passwort'), h('div', { class: 'field-row' }, certPassword, revealFor(certPassword))));

  const syncType = () => {
    loginOnly.hidden = typeSelect.value !== 'login';
    cardOnly.hidden = typeSelect.value !== 'card';
    certOnly.hidden = typeSelect.value !== 'certificate';
    serverOnly.hidden = typeSelect.value !== 'server';
  };
  typeSelect.addEventListener('change', syncType);
  syncType();
  syncSophos();
  updateMeter();

  const save = h('button', { type: 'submit', class: 'btn primary' }, icon('check'), t('Speichern'));
  const form = h('form', { class: 'item-form', autocomplete: 'off' },
    // typeFixed: the type was chosen before (button "Neu") – no type field then.
    ctx.typeFixed ? row(t('Tresor'), containerSelect) : h('div', { class: 'grid2' }, row(t('Tresor'), containerSelect), row(t('Typ'), typeSelect)),
    row(t('Titel'), title),
    row(t('Logo'), h('div', { class: 'field-row icon-row' }, iconPreview, iconChoose, iconFromSite, iconRemove)),
    loginOnly,
    cardOnly,
    certOnly,
    serverOnly,
    h('div', { class: 'grid2' }, row(t('Ordner'), h('div', {}, folder, folderOptions)), h('div', { class: 'field' }, h('label', {}, ' '), h('label', { class: 'inline' }, favorite, t('Favorit')))),
    row(t('Gültig bis (optional)'), h('div', { class: 'field-row' }, expires, h('span', { class: 'muted small' }, t('Erinnerung 30 Tage vorher, z. B. für Zertifikate, Service-Konten, Kundenzugänge')))),
    h('div', { class: 'field' }, h('label', {}, t('Zusätzliche Felder')), fieldsBox,
      h('button', { type: 'button', class: 'btn small', onclick: () => { addMenu.hidden = !addMenu.hidden; } }, icon('plus', 14), t('Feld hinzufügen')), addMenu),
    row(t('Notizen'), notes),
    h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'btn', onclick: () => ctx.onCancel() }, t('Abbrechen'))));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (totp.value.trim()) {
      try {
        parseTotp(totp.value);
      } catch (err) {
        toast(err.message, 'error');
        totp.focus();
        return;
      }
    }
    if (!containerSelect.value) {
      toast(t('Kein beschreibbarer Tresor verfügbar'), 'error');
      return;
    }
    const type = typeSelect.value;
    const login = type === 'login';
    if (type === 'certificate' && !cert) {
      toast(t('Bitte eine Zertifikatsdatei wählen'), 'error');
      return;
    }
    const next = {
      ...item,
      type,
      title: title.value,
      // A linked login keeps no own user name and password (they come from the linked entry when used).
      username: login ? (loginLink.value ? '' : username.value) : type === 'server' && !srvRdpLink.value ? srvUser.value : '',
      password: login ? (loginLink.value ? '' : password.value) : type === 'certificate' ? certPassword.value : type === 'server' && !srvRdpLink.value ? srvPass.value : '',
      loginLink: login ? loginLink.value : '',
      urls: login && !sophos.checked ? urls.value.split(/\r?\n/) : [],
      totp: login ? totp.value : '',
      card: type === 'card' ? { holder: cardHolder.value, number: cardNumber.value, expiry: cardExpiry.value, cvc: cardCvc.value, pin: cardPin.value } : undefined,
      cert: type === 'certificate' ? cert : undefined,
      server: type === 'server' ? {
        kind: srvKind.value, os: srvOs.value, mgmtUrl: srvMgmt.value, host: srvHost.value, port: srvPort.value, rdpLink: srvRdpLink.value, tvId: srvTvId.value,
        tvLink: srvTvLink.value, tvPassword: srvTvLink.value ? '' : srvTvPass.value,
        bastionUrl: srvBastion.value, bastionLoginLink: srvBastionLogin.value, bastionVmLink: srvBastionVm.value, bastionTenant: srvBastionTenant.value,
      } : undefined,
      msAdmin: login && msAdmin.checked,
      sophos: login && sophos.checked,
      portals: login && sophos.checked ? collectPortals() : [],
      folder: folder.value,
      icon: icon64,
      favorite: favorite.checked,
      expires: expires.value,
      // Date of the last password change (for the "old passwords" report).
      passwordChanged: (login || type === 'certificate') && (login ? password.value : certPassword.value) !== it.password ? new Date().toISOString() : it.passwordChanged,
      notes: notes.value,
      fields,
      passkeys,
    };
    save.disabled = true;
    try {
      await ctx.onSave(next, containerSelect.value);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      save.disabled = false;
    }
  });
  setTimeout(() => title.focus(), 0);
  return form;
}

function row(label, input) {
  return h('div', { class: 'field' }, h('label', {}, label), input);
}

/** Generator controls; calls onUse(password) with each new password. */
export function generatorPanel(options, onUse) {
  const output = h('code', { class: 'generated' });
  const lengthLabel = h('span');
  const regenerate = () => {
    const pw = generatePassword(options);
    output.textContent = pw;
    lengthLabel.textContent = String(options.length);
    onUse?.(pw);
    return pw;
  };
  const toggle = (key, label) => h('label', { class: 'inline' },
    h('input', { type: 'checkbox', checked: options[key], onchange: (e) => { options[key] = e.target.checked; regenerate(); } }), label);
  const panel = h('div', { class: 'generator' },
    h('div', { class: 'field-row' }, output, iconButton('refresh', t('Neu generieren'), regenerate)),
    h('div', { class: 'field-row' }, h('label', {}, t('Länge')),
      h('input', { type: 'range', min: 8, max: 64, value: options.length, oninput: (e) => { options.length = Number(e.target.value); regenerate(); } }),
      lengthLabel),
    h('div', { class: 'toggles' }, toggle('upper', 'A–Z'), toggle('lower', 'a–z'), toggle('digits', '0–9'), toggle('symbols', '!#$'), toggle('avoidAmbiguous', t('ohne l/1/O/0'))));
  panel.regenerate = regenerate;
  return panel;
}
