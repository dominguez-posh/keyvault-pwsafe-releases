// "Tresor-Vorgaben" (#480): a Verwalter sets appearance, contact person, rules and templates and protection defaults
// of a Key Vault vault for everyone. The main process checks the role again and cleans every value (vault-settings.js).

import { h, icon, iconButton, toast, modal } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import {
  DESCRIPTION_MAX, GENERATOR_MAX, GENERATOR_MIN, MAX_AGE_MONTHS, REQUIRED_FIELDS, REQUIRED_LABELS, VAULT_COLORS, VAULT_COLOR_LABELS, VAULT_ICONS,
  canEditSettings, orderFolders, passwordAgeNotice,
} from '../../../extension/core/vault-settings.js';
import { ITEM_TYPES } from '../../../extension/core/model.js';
import { call } from './ipc.js';
import { explicitFolders, items } from './state.js';
import { field, notice, tabbed } from './helpers.js';
import { reloadAll } from './shell.js';

export const canEditProfile = canEditSettings;

/** One choice of a fixed list as a row of toggle buttons (radio group). */
function choiceRow(cls, label, values, current, render) {
  let value = current;
  const row = h('div', { class: cls, role: 'radiogroup', 'aria-label': label });
  const draw = () => [...row.children].forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === value)));
  for (const v of values) {
    const b = h('button', { type: 'button', role: 'radio', dataset: { value: v }, onclick: () => { value = value === v ? '' : v; draw(); } }, render(v));
    row.append(b);
  }
  draw();
  return { el: row, get: () => value };
}

/** Top-level folders of the vault in the order to show (up/down per row). */
function folderOrderEditor(c, settings) {
  const own = [...new Set([...(explicitFolders.get(c.id) || []), ...items.filter((i) => i.containerId === c.id).map((i) => i.folder).filter(Boolean)]
    .map((f) => f.split('/')[0]))];
  let order = orderFolders(own, settings);
  const list = h('ol', { class: 'order-list' });
  const draw = () => list.replaceChildren(...order.map((f, i) => h('li', { dataset: { folder: f } }, icon('folder', 14), h('span', {}, f),
    iconButton('chevronDown', t('Nach unten'), () => { if (i < order.length - 1) { [order[i], order[i + 1]] = [order[i + 1], order[i]]; draw(); } }, { disabled: i === order.length - 1 }),
    iconButton('back', t('Nach oben'), () => { if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); } }, { disabled: i === 0 }))));
  draw();
  return { el: own.length ? list : h('p', { class: 'muted small' }, t('Noch keine Ordner in diesem Tresor.')), get: () => order };
}

function lookPage(c, s) {
  const color = choiceRow('color-choice', t('Farbe'), VAULT_COLORS, s.look.color, () => null);
  for (const b of color.el.children) {
    b.dataset.vaultColor = b.dataset.value;
    b.title = t(VAULT_COLOR_LABELS[b.dataset.value]);
    b.setAttribute('aria-label', b.title);
  }
  const symbol = choiceRow('symbol-choice', t('Symbol'), VAULT_ICONS, s.look.icon, (v) => icon(v, 16));
  for (const b of symbol.el.children) b.setAttribute('aria-label', b.dataset.value);
  const description = h('textarea', { name: 'vault-description', rows: 2, maxlength: DESCRIPTION_MAX }, s.look.description);
  const order = folderOrderEditor(c, s);
  return {
    label: t('Aussehen'), icon: 'image',
    content: [field(t('Farbe'), color.el), field(t('Symbol'), symbol.el),
      field(t('Kurzbeschreibung'), description, t('Höchstens {n} Zeichen, erscheint unter dem Namen des Tresors.', { n: DESCRIPTION_MAX })),
      field(t('Reihenfolge der Ordner'), order.el)],
    collect: () => ({ look: { color: color.get(), icon: symbol.get(), description: description.value, folderOrder: order.get() } }),
  };
}

function contactPage(c, s) {
  const name = h('input', { name: 'contact-name', value: s.contact.name, maxlength: 100, autocomplete: 'off' });
  const email = h('input', { name: 'contact-email', type: 'email', value: s.contact.email, maxlength: 254, autocomplete: 'off', spellcheck: 'false' });
  return {
    label: t('Ansprechpartner'), icon: 'user',
    content: [h('p', { class: 'muted' }, t('Wird angezeigt, wenn jemand keinen Zugriff hat oder den Tresor erst entsperren muss.')),
      field(t('Name'), name), field(t('E-Mail oder UPN'), email)],
    collect: () => ({ contact: { name: name.value, email: email.value } }),
  };
}

function rulesPage(c, s) {
  const g = s.rules.generator;
  const own = h('input', { type: 'checkbox', name: 'gen-own', checked: !!g });
  const length = h('input', { type: 'number', name: 'gen-length', min: GENERATOR_MIN, max: GENERATOR_MAX, value: g?.length || 20 });
  const classes = Object.fromEntries(Object.entries({ upper: 'A–Z', lower: 'a–z', digits: '0–9', symbols: '!#$' })
    .map(([k, label]) => [k, { box: h('input', { type: 'checkbox', name: `gen-${k}`, checked: g ? !!g[k] : true }), label }]));
  const required = Object.fromEntries(Object.entries(REQUIRED_FIELDS).map(([type, keys]) => [type, Object.fromEntries(keys.map((k) => [k,
    h('input', { type: 'checkbox', name: `req-${type}-${k}`, checked: (s.rules.required[type] || []).includes(k) })]))]));
  const age = h('input', { type: 'number', name: 'max-age', min: 0, max: MAX_AGE_MONTHS, value: s.rules.maxAgeMonths || 0 });
  let templates = [...s.rules.templates];
  const tplList = h('ul', { class: 'order-list' });
  const drawTemplates = () => tplList.replaceChildren(...(templates.length ? templates.map((tpl) => h('li', { dataset: { template: tpl.id } }, icon('note', 14),
    h('span', {}, `${tpl.name} · ${t(ITEM_TYPES[tpl.type])}`),
    iconButton('trash', t('Vorlage entfernen'), () => { templates = templates.filter((x) => x !== tpl); drawTemplates(); })))
    : [h('li', { class: 'muted small' }, t('Noch keine Vorlagen. Im Menü eines Eintrags: „Als Vorlage des Tresors speichern“.'))]));
  drawTemplates();
  return {
    label: t('Regeln und Vorlagen'), icon: 'wand',
    content: [
      h('h3', {}, t('Passwort-Generator')),
      h('label', { class: 'inline' }, own, t('Eigene Vorgaben für neue Passwörter in diesem Tresor')),
      h('div', { class: 'grid2' }, field(t('Länge'), length, t('{min} bis {max} Zeichen', { min: GENERATOR_MIN, max: GENERATOR_MAX })),
        h('div', { class: 'toggles' }, ...Object.values(classes).map((x) => h('label', { class: 'inline' }, x.box, x.label)))),
      h('h3', {}, t('Pflichtfelder')),
      ...Object.entries(required).map(([type, boxes]) => field(t(ITEM_TYPES[type]), h('div', { class: 'toggles' },
        ...Object.entries(boxes).map(([k, box]) => h('label', { class: 'inline' }, box, t(REQUIRED_LABELS[k])))))),
      h('h3', {}, t('Alter von Passwörtern')),
      field(t('Hinweis, wenn ein Passwort älter ist als (Monate)'), age, t('0 = kein Hinweis')),
      h('h3', {}, t('Vorlagen des Tresors')), tplList,
    ],
    collect: () => ({ rules: {
      generator: own.checked ? { length: Number(length.value), ...Object.fromEntries(Object.entries(classes).map(([k, x]) => [k, x.box.checked])) } : null,
      required: Object.fromEntries(Object.entries(required).map(([type, boxes]) => [type, Object.keys(boxes).filter((k) => boxes[k].checked)])),
      maxAgeMonths: Number(age.value) || 0,
      templates,
    } }),
  };
}

function protectPage(c, s) {
  const box = (key, label, hint) => {
    const input = h('input', { type: 'checkbox', name: `protect-${key}`, checked: key === 'private' ? s.protect.private === 'forbid' : !!s.protect[key] });
    return { input, el: h('label', { class: 'inline policy-row' }, input, h('span', {}, label, hint ? h('div', { class: 'muted small' }, hint) : null)) };
  };
  const boxes = {
    pinCopy: box('pinCopy', t('App-PIN beim Kopieren verlangen'), t('Auch wenn jemand für sich keine PIN-Abfrage eingestellt hat. Ohne App-PIN kein Kopieren aus diesem Tresor.')),
    pinExport: box('pinExport', t('App-PIN beim Export verlangen'), t('Ohne App-PIN kein Export.')),
    noExport: box('noExport', t('Export für diesen Tresor sperren')),
    private: box('private', t('„Nur für mich“ in diesem Tresor verbieten')),
  };
  return {
    label: t('Schutz'), icon: 'shield',
    content: [...Object.values(boxes).map((b) => b.el),
      notice(t('Diese Vorgaben setzt Keevault durch. Wer in Azure direkt Zugriff auf die Secrets hat, ist davon nicht betroffen – sie ersetzen keine Azure-Rollen.'), 'info')],
    collect: () => ({ protect: {
      pinCopy: boxes.pinCopy.input.checked, pinExport: boxes.pinExport.input.checked, noExport: boxes.noExport.input.checked,
      private: boxes.private.input.checked ? 'forbid' : 'allow',
    } }),
  };
}

export const PAGES = [lookPage, contactPage, rulesPage, protectPage];

/**
 * #480: notice above an entry whose password is older than the vault allows. Age: the entry's passwordChanged, else the
 * oldest version in its history (metadata only). live(): the entry is still the one shown. → element or null
 */
export async function ageNotice(c, item, live) {
  const settings = c?.vaultSettings;
  if (!settings?.rules?.maxAgeMonths || !(item?.type === 'login' || item?.type === 'certificate') || !item.password && !item.cert?.data) return null;
  let at = item.passwordChanged;
  if (!at) {
    const versions = await call('history', c.id, item.id).catch(() => []);
    const oldest = versions.at(-1)?.updated;
    at = oldest ? new Date(oldest).toISOString() : item.created;
  }
  const months = passwordAgeNotice(at, settings);
  if (!months || !live()) return null;
  return h('div', { class: 'notice warn password-age' }, t('Das Passwort ist {n} Monate alt – dieser Tresor sieht einen Wechsel nach {max} Monaten vor.', { n: months, max: settings.rules.maxAgeMonths }));
}

/** Menu action of an entry for a Verwalter: its preset values (no secrets) as a template of the vault. */
export function saveAsTemplate(c, item) {
  if (!c || !canEditSettings(c) || item?.type === 'server') return null;
  return { action: 'save-template', icon: 'note', label: t('Als Vorlage des Tresors speichern'), onClick: () => {
    const name = h('input', { name: 'template-name', value: item.title || '', maxlength: 80, autocomplete: 'off' });
    modal(t('Als Vorlage des Tresors speichern'), h('div', {},
      h('p', { class: 'muted' }, t('Die Vorlage übernimmt Titel, Benutzername, Websites, Notizen, Ordner und Felder – keine Passwörter, Einmalcodes, verborgenen Felder oder Dateien.')),
      field(t('Name der Vorlage'), name)), [
      { label: t('Abbrechen') },
      { label: t('Speichern'), primary: true, onClick: async () => {
        await call('addVaultTemplate', c.id, item.id, name.value);
        toast(t('Vorlage gespeichert'));
        await reloadAll();
        return true;
      } },
    ]);
    setTimeout(() => name.select(), 0);
  } };
}

/** The dialog; only for a Verwalter (the menu offers it only then, the main process refuses everyone else). */
export async function vaultProfileDialog(c) {
  let state;
  try {
    state = await call('vaultSettings', c.id);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const pages = PAGES.map((page) => page(c, state.settings));
  modal(t('Tresor-Vorgaben – {name}', { name: c.name }), h('div', { class: 'vault-profile' },
    h('p', { class: 'muted' }, t('Gilt für alle in diesem Tresor. Ändern dürfen nur Verwalter.')),
    state.canEdit ? null : notice(t('Du brauchst Verwaltungsrechte auf dem Tresor.')),
    tabbed('vault-profile', pages)), [
    { label: t('Abbrechen') },
    state.canEdit ? { label: t('Speichern'), primary: true, onClick: async () => {
      await call('setVaultSettings', c.id, Object.assign({}, ...pages.map((p) => p.collect())));
      toast(t('Tresor-Vorgaben gespeichert'));
      await reloadAll();
      return true;
    } } : null,
  ].filter(Boolean));
}
