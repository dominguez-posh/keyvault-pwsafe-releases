// Passkey dialogs (create / sign in), the unlock window and unlocking of protected containers.

import { h, icon, avatar, setChildren, toast } from '../core/dom.js';
import { unlockPanel } from '../core/ui-protect.js';
import { setLanguage, t } from '../core/i18n.js';
import { call } from '../lib/api.js';
import { protectCtx } from '../lib/protect-ctx.js';

const main = document.getElementById('main');
const footer = document.getElementById('footer');
const [mode, requestId] = location.hash.slice(1).split(':');
let st = null;

const button = (label, onClick, cls = 'btn') => h('button', { type: 'button', class: cls, onclick: onClick }, label);

function show(content, buttons = []) {
  setChildren(main, content);
  setChildren(footer, buttons);
}

const error = (message) => h('div', { class: 'notice error' }, message);

async function guard(fn, retry) {
  try {
    await fn();
  } catch (e) {
    show([error(e.message)], [button(t('Schließen'), () => window.close()), retry ? button(t('Erneut versuchen'), retry, 'btn primary') : null]);
  }
}

function site(details) {
  return h('div', { class: 'site' }, icon('key', 28), h('div', {},
    h('b', {}, details.rpName || details.rpId),
    h('span', { class: 'muted small' }, new URL(details.origin).host)));
}

async function unlockThen(next) {
  show([h('div', { class: 'center' }, h('span', { class: 'spinner' }), t('Anmeldung bei Microsoft Entra ID …'))]);
  await call('unlock');
  await next();
}

const fallback = () => call('webauthn:fallback', { requestId }).finally(() => window.close());
const cancel = () => call('webauthn:cancel', { requestId }).finally(() => window.close());

async function renderUnlock() {
  await guard(async () => {
    show([h('p', {}, t('Melde dich an, um den Tresor zu entsperren.')), h('span', { class: 'spinner' })]);
    await call('unlock');
    show([h('div', { class: 'notice info' }, t('Entsperrt.'))]);
    setTimeout(() => window.close(), 600);
  }, renderUnlock);
}

/** Unlock panels for locked protected containers; next() runs when all are open (or the user continues). */
async function renderContainers(next, filter = () => true) {
  st = await call('state');
  const locked = st.containers.filter((c) => c.protected && c.locked && filter(c));
  if (!locked.length) {
    if (next) return next();
    show([h('div', { class: 'notice info' }, t('Alle Tresore sind entsperrt.'))], [button(t('Schließen'), () => window.close(), 'btn primary')]);
    return undefined;
  }
  const ctx = protectCtx(st.account);
  const panels = [];
  for (const c of locked) {
    if (c.kind === 'remote') {
      panels.push(h('div', { class: 'unlock-panel' }, h('div', { class: 'unlock-head' }, icon('note', 24), h('div', {}, h('h3', {}, c.name), h('div', { class: 'muted small' }, t('Datei-Tresore der Desktop-App')))),
        button(t('In der Desktop-App entsperren'), () => call('desktopFocus').catch((e) => toast(e.message, 'error')))));
      continue;
    }
    const info = await call('protection:info', { containerId: c.id });
    panels.push(unlockPanel(c, info, ctx, () => renderContainers(next, filter)));
  }
  show(panels, [next ? button(t('Weiter'), () => next(), 'btn primary') : button(t('Schließen'), () => window.close())]);
  return undefined;
}

function lockedView(details, next) {
  show([
    site(details),
    h('p', {}, details.kind === 'create'
      ? t('Der Tresor ist gesperrt. Entsperre ihn, um den Passkey in Azure Key Vault zu speichern.')
      : t('Der Tresor ist gesperrt. Entsperre ihn, um dich mit einem gespeicherten Passkey anzumelden.')),
  ], [
    button(t('Abbrechen'), cancel),
    button(t('Anderes Gerät verwenden'), fallback),
    button(t('Entsperren'), () => guard(() => unlockThen(next), next), 'btn primary'),
  ]);
}

function lockedHint(d, again) {
  if (!d.lockedContainers?.length) return null;
  return h('div', { class: 'notice' }, t('Gesperrt: {names}', { names: d.lockedContainers.map((c) => c.name).join(', ') }), ' ',
    h('button', { type: 'button', class: 'linklike', onclick: () => renderContainers(again) }, t('Entsperren')));
}

async function renderCreate() {
  const d = await call('webauthn:details', { requestId });
  if (!d.unlocked) return lockedView(d, renderCreate);
  if (!d.containers.length) {
    return show([site(d), error(t('Kein Tresor mit Schreibrechten verfügbar.')), lockedHint(d, renderCreate)], [button(t('Abbrechen'), cancel), button(t('Anderes Gerät verwenden'), fallback, 'btn primary')]);
  }
  const container = h('select', {}, ...d.containers.map((c) => h('option', { value: c.id, selected: c.id === d.defaultContainer }, c.name)));
  const title = h('input', { value: d.rpName || d.rpId });
  const asNew = h('input', { type: 'radio', name: 'target', checked: true });
  const asExisting = h('input', { type: 'radio', name: 'target' });
  const existing = h('select', { disabled: true }, ...d.logins.map((l) => h('option', { value: `${l.containerId}|${l.id}` }, `${l.title}${l.username ? ` – ${l.username}` : ''} (${l.container})`)));
  const sync = () => {
    existing.disabled = !asExisting.checked;
    container.disabled = asExisting.checked;
    title.disabled = asExisting.checked;
  };
  asNew.addEventListener('change', sync);
  asExisting.addEventListener('change', sync);

  const save = button(t('Passkey speichern'), () => guard(async () => {
    save.disabled = true;
    save.replaceChildren(h('span', { class: 'spinner' }), t('Speichern …'));
    const [cid, itemId] = asExisting.checked ? existing.value.split('|') : [container.value, ''];
    await call('webauthn:approve', { requestId, containerId: cid, itemId, title: title.value });
    window.close();
  }, renderCreate), 'btn primary');

  show([
    site(d),
    h('p', {}, t('Passkey für {user} in Keevault speichern?', { user: d.user?.name || d.user?.displayName || t('dieses Konto') })),
    d.alreadyRegistered.length ? h('div', { class: 'notice' }, t('Für dieses Konto ist bereits ein Passkey im Tresor gespeichert. Die Website lehnt einen zweiten vermutlich ab.')) : null,
    lockedHint(d, renderCreate),
    h('label', { class: 'radio' }, asNew, h('div', { style: { flex: '1' } }, h('div', {}, t('Neuer Eintrag')),
      h('div', { class: 'field' }, h('label', {}, t('Tresor')), container),
      h('div', { class: 'field' }, h('label', {}, t('Titel')), title))),
    d.logins.length ? h('label', { class: 'radio' }, asExisting, h('div', { style: { flex: '1' } }, h('div', {}, t('Zu vorhandenem Login hinzufügen')), existing)) : null,
  ], [button(t('Abbrechen'), cancel), button(t('Anderes Gerät verwenden'), fallback), save]);
  save.focus();
  return undefined;
}

async function renderGet() {
  const d = await call('webauthn:details', { requestId });
  if (!d.unlocked) return lockedView(d, renderGet);
  if (!d.candidates.length) {
    show([site(d), h('p', {}, t('Im Tresor ist kein passender Passkey gespeichert.')), lockedHint(d, renderGet)],
      [button(t('Abbrechen'), cancel), button(t('Anderes Gerät verwenden'), fallback, 'btn primary')]);
    return undefined;
  }
  const choices = d.candidates.map((c) => h('button', { type: 'button', class: 'choice', onclick: () => guard(async () => {
    show([h('span', { class: 'spinner' }), ` ${t('Anmeldung …')}`]);
    await call('webauthn:approve', { requestId, containerId: c.containerId, itemId: c.itemId, credentialId: c.credentialId });
    window.close();
  }, renderGet) }, avatar(c.userName || c.title), h('div', { class: 'row-text' },
    h('div', { class: 'row-title' }, c.userName || t('(ohne Benutzername)')),
    h('div', { class: 'row-sub' }, `${c.title} · ${c.container}`)), icon('fill')));
  show([site(d), h('p', {}, t('Mit welchem Passkey möchtest du dich anmelden?')), ...choices, lockedHint(d, renderGet)],
    [button(t('Abbrechen'), cancel), button(t('Anderes Gerät verwenden'), fallback)]);
  choices[0].focus();
  return undefined;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (mode === 'unlock' || mode === 'containers') window.close();
    else cancel();
  }
});

(async () => {
  st = await call('state');
  setLanguage(st.settings.language);
  document.title = 'Keevault';
  if (mode === 'unlock') renderUnlock();
  else if (mode === 'containers') guard(() => renderContainers(null, (c) => !requestId || c.id === requestId));
  else if (mode === 'create') guard(renderCreate, renderCreate);
  else if (mode === 'get') guard(renderGet, renderGet);
  else show([error(t('Unbekannte Anfrage'))], [button(t('Schließen'), () => window.close())]);
})();
