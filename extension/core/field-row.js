// Desktop app and extension popup (#449, #464): field rows of the detail view that act like in a password manager – the row is shaded on hover,
// the action stands as text on the right, an arrow button opens a menu. Everything calls existing paths
// (ctx.copy, ctx.openUrl, ctx.typeInto); nothing new happens here. ctx.fieldMenu (else ctx.menu) opens the arrow menu.

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
        (ctx.fieldMenu || ctx.menu)(more, menu(), { below: true });
      },
    }, icon('chevronDown', 16));
  }
  const row = h('div', { class: 'field-row act-row' }, value, act, more);
  row.actionRun = run;
  row.addEventListener('click', (e) => {
    if (e.target.closest('.act-more')) return;
    e.preventDefault();
    run();
  });
  return row;
}

/**
 * #458: the whole field card is the click target. A click on the label or the empty space runs the action of the card's
 * only row (several rows, e.g. more addresses, keep their own click); the row, the action text and the arrow button
 * handle themselves. The card is focusable and Enter runs the action. A card with one row is marked `single`: its action
 * text and arrow show as soon as the mouse is anywhere on the card; with several rows each row shows its own on hover.
 */
export function actionCard(label, ...rows) {
  const only = rows.length === 1 ? rows[0] : null;
  const card = h('div', { class: only ? 'field act-card single' : 'field act-card', tabindex: '0' }, h('label', {}, label), ...rows);
  card.addEventListener('click', (e) => {
    if (!only || e.target.closest('.act-row, button, a')) return;
    e.preventDefault();
    only.actionRun();
  });
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target !== card || !only) return;
    e.preventDefault();
    only.actionRun();
  });
  return card;
}

/** Large display of a value (display only): digits, letters and symbols in different tones, monospace. */
export function bigView(label, value) {
  const kind = (c) => (/\d/.test(c) ? 'd' : /[A-Za-z]/.test(c) ? 'l' : 's');
  modal(label, h('div', { class: 'big-text', dir: 'ltr' }, ...[...value].map((c) => h('span', { class: `big-ch ${kind(c)}` }, c))),
    [{ label: t('Schließen') }]);
}

/** Menu entry for typing into the previous window, only where the app offers it. */
export const typeEntry = (ctx, what) => (ctx.typeInto ? [{ action: 'type', icon: 'fill', label: t('In Fenster eingeben'), onClick: () => ctx.typeInto(what) }] : []);

/** Password and other hidden values: "Copy securely" (ctx.secureCopy === false: plain "Copy", the browser clipboard); menu: show/hide, large display, type into a window. */
export function secretRow(label, value, ctx, { masked, copyValue, typeWhat }) {
  const span = h('span', { class: 'value secret' }, masked);
  let shown = false;
  const toggle = () => {
    shown = !shown;
    span.textContent = shown ? value : masked;
    span.classList.toggle('revealed', shown);
  };
  return actionRow(span, {
    ctx, label, action: ctx.secureCopy === false ? t('Kopieren') : t('Sicher kopieren'), run: () => ctx.copy(copyValue, label),
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
    ctx, label: url, action: ctx.openLabel || t('Öffnen und ausfüllen'), run: () => ctx.openUrl(url),
    menu: () => [{ action: 'copy-url', icon: 'copy', label: t('Adresse kopieren'), onClick: () => ctx.copy(url, t('Adresse')) }],
  });
}
