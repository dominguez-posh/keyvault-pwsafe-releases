// Item detail view and editor, shared by the extension popup and the desktop app.

import { h, icon, iconButton, formatDateTime, avatar, toast } from './dom.js';
import { totpCode, parseTotp } from './totp.js';
import { generatePassword, passwordStrength, DEFAULT_OPTIONS } from './generator.js';
import { ITEM_TYPES, CERT_MAX_BYTES, FIELD_TYPES, FIELD_FILE_MAX_BYTES, normalizeItem, formatCardNumber } from './model.js';
import { t } from './i18n.js';
import { pickImage, ICON_MAX_CHARS } from './image.js';
import { expiryState } from './health.js';

/**
 * @param {object} item  parsed item
 * @param {{ copy: (text: string, label: string) => void, openUrl: (url: string) => void,
 *           containerName: (id: string) => string, actions?: Array<{ icon, label, onClick, danger?, primary? }>,
 *           onRemovePasskey?: (credentialId: string) => void }} ctx
 */
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

  return h('div', { class: 'item-detail' },
    h('div', { class: 'item-head' },
      avatar(item.title, 'avatar large', item.icon),
      h('div', { class: 'item-head-text' },
        h('h2', {}, item.favorite ? icon('star', 14) : null, item.title),
        h('div', { class: 'muted' }, [ctx.containerName(item.containerId), item.folder, t(ITEM_TYPES[item.type])].filter(Boolean).join(' · ')),
        expiryBadge(item.expires))),
    rows.length ? rows : h('p', { class: 'muted' }, t('Keine Felder')),
    h('div', { class: 'meta muted' }, item.updatedBy
      ? t('Geändert {date} von {user}', { date: formatDateTime(item.updated), user: item.updatedBy })
      : t('Geändert {date}', { date: formatDateTime(item.updated) })),
    ctx.actions?.length ? h('div', { class: 'actions' }, ...ctx.actions.map((a) => h('button', {
      type: 'button', class: a.danger ? 'btn danger' : a.primary ? 'btn primary' : 'btn', onclick: a.onClick,
    }, icon(a.icon), a.label))) : null);
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

function passkeyList(passkeys, ctx) {
  return h('div', { class: 'field' }, h('label', {}, passkeys.length > 1 ? t('Passkeys') : t('Passkey')),
    ...passkeys.map((p) => h('div', { class: 'passkey-row' },
      icon('key'),
      h('div', { class: 'passkey-text' },
        h('div', {}, p.userName || p.userDisplayName || t('(ohne Benutzername)')),
        h('div', { class: 'muted small' }, t('{rpId} · erstellt {date}', { rpId: p.rpId, date: formatDateTime(p.created) }))),
      ctx.onRemovePasskey ? iconButton('trash', t('Passkey entfernen'), () => ctx.onRemovePasskey(p.credentialId)) : null)));
}

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
  const typeSelect = h('select', { name: 'type' },
    ...Object.entries(ITEM_TYPES).map(([k, label]) => h('option', { value: k, selected: k === it.type }, t(label))));
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
  const drawIcon = () => {
    iconPreview.replaceChildren(avatar(title.value || it.title, 'avatar', icon64));
    iconRemove.hidden = !icon64;
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

  const loginOnly = h('div', { class: 'login-only' },
    row(t('Benutzername'), username),
    h('div', { class: 'field' }, h('label', {}, t('Passwort')), h('div', { class: 'field-row' }, password, reveal, genButton), meter, generator),
    row(t('Websites'), urls),
    row(t('Einmalcode (TOTP)'), h('div', { class: 'field-row' }, totp, revealTotp, scanTotp)),
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
  };
  typeSelect.addEventListener('change', syncType);
  syncType();
  updateMeter();

  const save = h('button', { type: 'submit', class: 'btn primary' }, icon('check'), t('Speichern'));
  const form = h('form', { class: 'item-form', autocomplete: 'off' },
    // typeFixed: the type was chosen before (button "Neu") – no type field then.
    ctx.typeFixed ? row(t('Tresor'), containerSelect) : h('div', { class: 'grid2' }, row(t('Tresor'), containerSelect), row(t('Typ'), typeSelect)),
    row(t('Titel'), title),
    row(t('Logo'), h('div', { class: 'field-row icon-row' }, iconPreview, iconChoose, iconRemove)),
    loginOnly,
    cardOnly,
    certOnly,
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
      username: login ? username.value : '',
      password: login ? password.value : type === 'certificate' ? certPassword.value : '',
      urls: login ? urls.value.split(/\r?\n/) : [],
      totp: login ? totp.value : '',
      card: type === 'card' ? { holder: cardHolder.value, number: cardNumber.value, expiry: cardExpiry.value, cvc: cardCvc.value, pin: cardPin.value } : undefined,
      cert: type === 'certificate' ? cert : undefined,
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
