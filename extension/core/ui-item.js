// Item detail view and editor, shared by the extension popup and the desktop app.

import { h, icon, iconButton, formatDateTime, avatar, toast } from './dom.js';
import { totpCode, parseTotp } from './totp.js';
import { generatePassword, passwordStrength, DEFAULT_OPTIONS } from './generator.js';
import { ITEM_TYPES, normalizeItem } from './model.js';
import { t } from './i18n.js';
import { pickImage, ICON_MAX_CHARS } from './image.js';

/**
 * @param {object} item  parsed item
 * @param {{ copy: (text: string, label: string) => void, openUrl: (url: string) => void,
 *           containerName: (id: string) => string, actions?: Array<{ icon, label, onClick, danger?, primary? }>,
 *           onRemovePasskey?: (credentialId: string) => void }} ctx
 */
export function itemDetail(item, ctx) {
  const rows = [];
  if (item.username) rows.push(textField(t('Benutzername'), item.username, ctx));
  if (item.password) rows.push(secretField(t('Passwort'), item.password, ctx));
  if (item.totp) rows.push(totpField(item.totp, ctx));
  if (item.urls.length) {
    rows.push(h('div', { class: 'field' }, h('label', {}, item.urls.length > 1 ? t('Websites') : t('Website')),
      ...item.urls.map((u) => h('div', { class: 'field-row' },
        h('a', { href: '#', class: 'url', title: u, onclick: (e) => { e.preventDefault(); ctx.openUrl(u); } }, u),
        iconButton('copy', t('Kopieren'), () => ctx.copy(u, t('Adresse')))))));
  }
  if (item.passkeys.length) rows.push(passkeyList(item.passkeys, ctx));
  for (const f of item.fields) rows.push(f.hidden ? secretField(f.name, f.value, ctx) : textField(f.name, f.value, ctx));
  if (item.notes) rows.push(h('div', { class: 'field' }, h('label', {}, t('Notizen')), h('div', { class: 'notes' }, item.notes)));

  return h('div', { class: 'item-detail' },
    h('div', { class: 'item-head' },
      avatar(item.title, 'avatar large', item.icon),
      h('div', { class: 'item-head-text' },
        h('h2', {}, item.favorite ? icon('star', 14) : null, item.title),
        h('div', { class: 'muted' }, [ctx.containerName(item.containerId), item.folder, t(ITEM_TYPES[item.type])].filter(Boolean).join(' · ')))),
    rows.length ? rows : h('p', { class: 'muted' }, t('Keine Felder')),
    h('div', { class: 'meta muted' }, item.updatedBy
      ? t('Geändert {date} von {user}', { date: formatDateTime(item.updated), user: item.updatedBy })
      : t('Geändert {date}', { date: formatDateTime(item.updated) })),
    ctx.actions?.length ? h('div', { class: 'actions' }, ...ctx.actions.map((a) => h('button', {
      type: 'button', class: a.danger ? 'btn danger' : a.primary ? 'btn primary' : 'btn', onclick: a.onClick,
    }, icon(a.icon), a.label))) : null);
}

function textField(label, value, ctx) {
  return h('div', { class: 'field' }, h('label', {}, label),
    h('div', { class: 'field-row' }, h('span', { class: 'value' }, value), iconButton('copy', t('Kopieren'), () => ctx.copy(value, label))));
}

function secretField(label, value, ctx) {
  const span = h('span', { class: 'value secret' }, '••••••••••••');
  let shown = false;
  const toggle = iconButton('eye', t('Anzeigen'), () => {
    shown = !shown;
    span.textContent = shown ? value : '••••••••••••';
    span.classList.toggle('revealed', shown);
    toggle.replaceChildren(icon(shown ? 'eyeOff' : 'eye'));
  });
  return h('div', { class: 'field' }, h('label', {}, label),
    h('div', { class: 'field-row' }, span, toggle, iconButton('copy', t('Kopieren'), () => ctx.copy(value, label))));
}

function totpField(secret, ctx) {
  const code = h('span', { class: 'value totp' }, '––– –––');
  const ring = h('span', { class: 'totp-timer' });
  const el = h('div', { class: 'field' }, h('label', {}, t('Einmalcode (TOTP)')),
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
  const folder = h('input', { name: 'folder', value: it.folder || (ctx.isNew && ctx.defaultFolder) || '', placeholder: t('optional, z. B. Kunden/Contoso'), list: 'folder-options' });
  const folderOptions = h('datalist', { id: 'folder-options' }, ...(ctx.folders || []).map((f) => h('option', { value: f })));
  const favorite = h('input', { type: 'checkbox', name: 'favorite', checked: it.favorite });
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
  const renderFields = () => {
    fieldsBox.replaceChildren(...fields.map((f, i) => h('div', { class: 'custom-field' },
      h('input', { value: f.name, placeholder: t('Name'), oninput: (e) => { fields[i].name = e.target.value; } }),
      h('input', { value: f.value, placeholder: t('Wert'), type: f.hidden ? 'password' : 'text', oninput: (e) => { fields[i].value = e.target.value; } }),
      h('label', { class: 'inline', title: t('Verborgen') }, h('input', { type: 'checkbox', checked: f.hidden, onchange: (e) => { fields[i].hidden = e.target.checked; renderFields(); } }), icon('eyeOff', 14)),
      iconButton('x', t('Feld entfernen'), () => { fields.splice(i, 1); renderFields(); }))));
  };
  renderFields();

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
    row(t('Einmalcode (TOTP)'), h('div', { class: 'field-row' }, totp, revealTotp)),
    passkeyBox);
  const syncType = () => { loginOnly.hidden = typeSelect.value !== 'login'; };
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
    h('div', { class: 'grid2' }, row(t('Ordner'), h('div', {}, folder, folderOptions)), h('div', { class: 'field' }, h('label', {}, ' '), h('label', { class: 'inline' }, favorite, t('Favorit')))),
    h('div', { class: 'field' }, h('label', {}, t('Zusätzliche Felder')), fieldsBox,
      h('button', { type: 'button', class: 'btn small', onclick: () => { fields.push({ name: '', value: '', hidden: false }); renderFields(); } }, icon('plus', 14), t('Feld hinzufügen'))),
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
    const login = typeSelect.value === 'login';
    const next = {
      ...item,
      type: typeSelect.value,
      title: title.value,
      username: login ? username.value : '',
      password: login ? password.value : '',
      urls: login ? urls.value.split(/\r?\n/) : [],
      totp: login ? totp.value : '',
      folder: folder.value,
      icon: icon64,
      favorite: favorite.checked,
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
