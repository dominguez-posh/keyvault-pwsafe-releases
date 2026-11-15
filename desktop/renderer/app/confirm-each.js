// #537 2b "Immer bestätigen" in the window: the proof for one use of an entry of a vault the option covers, and the
// option with its scope (all vaults or only the personal vault, Lucas 13.11.2026) in the protection dialog of the personal
// vault. The main process checks everything (desktop/access-confirm.js, desktop/main/access.js).

import { h, icon, toast, modal } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { st } from './state.js';
import { field, helloProofButton, secretLabel } from './helpers.js';

const PURPOSE_LABEL = {
  view: 'Bestätigen zum Anzeigen',
  copy: 'Bestätigen zum Kopieren',
  type: 'Bestätigen zum Eintippen',
  fill: 'Bestätigen zum Verwenden',
  move: 'Bestätigen zum Verschieben',
  backup: 'Bestätigen zum Sichern',
  share: 'Bestätigen zum Freigeben',
};

/**
 * Asks for the master password, the PIN or Windows Hello; the main process checks it and lets exactly this one use
 * through (access: { containerId, itemId, purpose }; for 'move' itemId may list the entries of a selection). → true when confirmed.
 */
export function accessPrompt(access) {
  const { containerId, itemId, purpose } = access || {};
  if (!containerId || !itemId || !PURPOSE_LABEL[purpose]) return Promise.resolve(false);
  const many = Array.isArray(itemId) && itemId.length > 1;
  return new Promise((resolve) => {
    const input = h('input', { type: 'password', autocomplete: 'off', class: 'access-proof', 'aria-label': secretLabel() });
    let ok = false;
    const proofField = field(secretLabel(), input);
    const hello = helloProofButton(async (proof) => {
      try {
        ok = await call('confirmAccess', containerId, itemId, purpose, proof);
        close();
        return true;
      } catch (err) {
        toast(err.message, 'error');
        return false;
      }
    }, { field: proofField });
    const { dialog, close } = modal(t(PURPOSE_LABEL[purpose]), h('div', { class: 'access-confirm' },
      h('p', {}, many
        ? t('Für diesen Tresor gilt „Immer bestätigen“. Die Bestätigung gilt für das Verschieben dieser {n} Einträge.', { n: itemId.length })
        : t('Für diesen Tresor gilt „Immer bestätigen“ (Windows Hello, Masterpasswort oder PIN). Die Bestätigung gilt nur für diesen einen Zugriff.')),
      hello, proofField), [
      { label: t('Abbrechen') },
      { label: t('Bestätigen'), primary: !st.unlock?.hello, onClick: async () => { // Lena: one primary button – Hello's
        try {
          ok = await call('confirmAccess', containerId, itemId, purpose, input.value);
          return true;
        } catch (err) {
          toast(err.message, 'error');
          input.select();
          return false;
        }
      } },
    ]);
    dialog.classList.add('access-confirm-modal');
    dialog.addEventListener('close', () => resolve(ok));
    setTimeout(() => input.focus(), 0);
  });
}

/** Switching the option or its scope: the proof first (master password, PIN or Windows Hello). → the new state or null */
function switchPrompt(containerId, on, scope, scopeOnly = false) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'password', autocomplete: 'off', class: 'confirm-each-proof', 'aria-label': secretLabel() });
    let result = null;
    const send = async (proof) => {
      result = await call('setConfirmEach', containerId, on, proof, scope);
      toast(on ? t('„Immer bestätigen“ ist eingeschaltet') : t('„Immer bestätigen“ ist ausgeschaltet'));
    };
    const switchField = field(secretLabel(), input);
    const hello = helloProofButton(async (proof) => {
      try {
        await send(proof);
        close();
        return true;
      } catch (err) {
        toast(err.message, 'error');
        return false;
      }
    }, { field: switchField });
    const { dialog, close } = modal(scopeOnly ? t('Umfang von „Immer bestätigen“ ändern') : on ? t('„Immer bestätigen“ einschalten') : t('„Immer bestätigen“ ausschalten'), h('div', {},
      h('p', {}, !on ? t('Danach zeigt und kopiert Keevault Passwörter wieder ohne eigene Bestätigung.')
        : scope === 'personal'
          ? t('Danach verlangt jedes Anzeigen, Kopieren, Eintippen, Ausfüllen und Verschieben eines Passworts aus deinem persönlichen Tresor eine Bestätigung – auch in der Browser-Erweiterung und für KI-Agenten. Liste und Suche bleiben frei.')
          : t('Danach verlangt jedes Anzeigen, Kopieren, Eintippen, Ausfüllen und Verschieben eines Passworts aus allen Tresoren eine Bestätigung – auch in der Browser-Erweiterung und für KI-Agenten. Liste und Suche bleiben frei.')),
      hello, switchField), [
      { label: t('Abbrechen') },
      { label: scopeOnly ? t('Ändern') : on ? t('Einschalten') : t('Ausschalten'), primary: !st.unlock?.hello, onClick: async () => {
        try {
          await send(input.value);
          return true;
        } catch (err) {
          toast(err.message, 'error');
          input.select();
          return false;
        }
      } },
    ]);
    dialog.addEventListener('close', () => resolve(result));
    setTimeout(() => input.focus(), 0);
  });
}

/** The section of the protection dialog of the personal vault (extension/core/ui-protect.js asks for it). */
export async function confirmEachSection(container) {
  if (!container?.personal || !st?.unlock?.migrated) return null;
  let state;
  try {
    state = await call('confirmEachState', container.id);
  } catch {
    return null;
  }
  let on = state?.on === true;
  let scope = state?.scope === 'personal' ? 'personal' : 'all';
  const box = h('input', { type: 'checkbox', class: 'confirm-each-toggle', checked: on });
  const select = h('select', { class: 'confirm-each-scope', disabled: !on, 'aria-label': t('Gilt für') },
    ...[['all', t('alle Tresore (Standard)')], ['personal', t('nur persönlicher Tresor')]].map(([v, label]) => h('option', { value: v, selected: scope === v }, label)));
  const show = (r) => {
    if (!r) return;
    on = r.on === true;
    scope = r.scope === 'personal' ? 'personal' : 'all';
  };
  const sync = () => {
    box.checked = on;
    select.value = scope;
    select.disabled = !on;
  };
  box.addEventListener('change', async () => {
    const want = box.checked;
    sync(); // stays as it was until the main process confirms the change
    show(await switchPrompt(container.id, want, want ? select.value : scope));
    sync();
  });
  select.addEventListener('change', async () => {
    const want = select.value === 'personal' ? 'personal' : 'all';
    sync();
    if (on) show(await switchPrompt(container.id, true, want, true));
    sync();
  });
  return [
    h('h3', {}, t('Immer bestätigen')),
    h('label', { class: 'check confirm-each' }, box, h('span', {}, t('Für jedes Anzeigen, Kopieren, Ausfüllen und Verschieben eines Passworts eine Bestätigung verlangen'))),
    field(t('Gilt für'), select),
    h('p', { class: 'muted small' }, icon('shield', 12), ' ', t('Gilt auf allen Geräten mit diesem Tresor, auch für die Browser-Erweiterung und KI-Agenten. Schützt vor jemandem am entsperrten Gerät, nicht vor Schadsoftware.')),
  ];
}
