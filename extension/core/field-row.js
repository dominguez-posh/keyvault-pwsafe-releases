// Desktop only (#449): field rows of the detail view that act like in a password manager – the row is shaded on hover,
// the action stands as text on the right, an arrow button opens a menu. Everything calls existing paths
// (ctx.copy, ctx.openUrl, ctx.typeInto); nothing new happens here.

import { h, icon, modal } from './dom.js';
import { t } from './i18n.js';

/**
 * One row. Click anywhere on the row (or Enter on the action button) runs the action; the arrow button opens
 * `menu()` (items for ctx.menu). The action text and arrow show on hover and on keyboard focus.
 */
export function actionRow(value, { ctx, label, action, run, menu }) {
  const act = h('button', { type: 'button', class: 'act-label', 'aria-label': `${action}: ${label}` }, action);
  let more = null;
  if (menu) {
    more = h('button', {
      type: 'button', class: 'icon-btn act-more', title: t('Weitere Aktionen'), 'aria-haspopup': 'menu',
      'aria-label': `${t('Weitere Aktionen')}: ${label}`,
      onclick: (e) => {
        e.stopPropagation();
        ctx.menu(more, menu(), { below: true });
      },
    }, icon('chevronDown', 16));
  }
  const row = h('div', { class: 'field-row act-row' }, value, act, more);
  row.addEventListener('click', (e) => {
    if (e.target.closest('.act-more')) return;
    e.preventDefault();
    run();
  });
  return row;
}

/** Large display of a value (display only): digits, letters and symbols in different tones, monospace. */
export function bigView(label, value) {
  const kind = (c) => (/\d/.test(c) ? 'd' : /[A-Za-z]/.test(c) ? 'l' : 's');
  modal(label, h('div', { class: 'big-text', dir: 'ltr' }, ...[...value].map((c) => h('span', { class: `big-ch ${kind(c)}` }, c))),
    [{ label: t('Schließen') }]);
}

/** Menu entry for typing into the previous window, only where the app offers it. */
export const typeEntry = (ctx, what) => (ctx.typeInto ? [{ action: 'type', icon: 'fill', label: t('In Fenster eingeben'), onClick: () => ctx.typeInto(what) }] : []);

/** Password and other hidden values: "Copy securely"; menu: show/hide, large display, type into a window. */
export function secretRow(label, value, ctx, { masked, copyValue, typeWhat }) {
  const span = h('span', { class: 'value secret' }, masked);
  let shown = false;
  const toggle = () => {
    shown = !shown;
    span.textContent = shown ? value : masked;
    span.classList.toggle('revealed', shown);
  };
  return actionRow(span, {
    ctx, label, action: t('Sicher kopieren'), run: () => ctx.copy(copyValue, label),
    menu: () => [
      { action: 'reveal', icon: shown ? 'eyeOff' : 'eye', label: shown ? t('Ausblenden') : t('Anzeigen'), onClick: toggle },
      { action: 'big', icon: 'type', label: t('In großer Schrift anzeigen'), onClick: () => bigView(label, value) },
      ...(typeWhat ? typeEntry(ctx, typeWhat) : []),
    ],
  });
}

/** User name: "Copy"; menu only with the typing entry (nothing else makes sense there). */
export function userRow(label, value, ctx, { typeWhat } = {}) {
  const entries = typeWhat ? typeEntry(ctx, typeWhat) : [];
  return actionRow(h('span', { class: 'value' }, value), {
    ctx, label, action: t('Kopieren'), run: () => ctx.copy(value, label), menu: entries.length ? () => entries : null,
  });
}

/** Address: "Open and fill"; menu: copy the address. */
export function urlRow(url, ctx) {
  return actionRow(h('a', { href: '#', class: 'url' }, url), {
    ctx, label: url, action: t('Öffnen und ausfüllen'), run: () => ctx.openUrl(url),
    menu: () => [{ action: 'copy-url', icon: 'copy', label: t('Adresse kopieren'), onClick: () => ctx.copy(url, t('Adresse')) }],
  });
}
