// #539 Etappe 8 in the window: secured file vaults at the app's master password – the choice when creating or
// requesting, "Mit Masterpasswort öffnen", "Nur mit Passkey" and replacements in the members view, and "master
// password compromised" in the key change of the personal vault. The member key itself never reaches the window.

import { h, toast, modal, confirmDialog } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { st } from './state.js';
import { notice } from './helpers.js';
import { codeInput } from './break-glass.js';

/** The organization allows secured files only with a passkey (policy SharedVaultPasskeyOnly). */
export const passkeyOnlyPolicy = () => !!st?.settings?.enforced?.includes?.('sharedVaultPasskeyOnly') && st.settings.sharedVaultPasskeyOnly === true;

/** "Anmelden mit": the app's master password (recommended, unless the policy forbids it) or a passkey. */
export function methodSelect() {
  const allowApp = !passkeyOnlyPolicy();
  return h('select', { 'data-member-method': '' },
    allowApp ? h('option', { value: 'app' }, t('Masterpasswort der App (empfohlen)')) : null,
    h('option', { value: 'platform' }, t('Windows Hello auf diesem Gerät (PIN, Gesicht, Fingerabdruck)')),
    h('option', { value: 'cross-platform' }, t('Sicherheitsschlüssel oder Smartphone')));
}

/** The call arguments for a choice of methodSelect: { method } or { attachment }. */
export const methodArgs = (value) => (value === 'app' ? { method: 'app' } : { attachment: value });

export const METHOD_HINT = 'Mit dem Masterpasswort der App öffnest du die Datei auf jedem Gerät mit deinem persönlichen Tresor – mit Windows Hello, dem Masterpasswort oder der App-PIN. Mit einem Passkey öffnet sie sich nur mit diesem Passkey. Für sensible Tresore kann ein Admin „Nur mit Passkey“ einschalten.';

/** Members view: the admin's switch "passkeys only" with what it means. op(o, message) runs the member operation. */
export function passkeyOnlySwitch(info, op) {
  const box = h('input', { type: 'checkbox', checked: !!info.passkeyOnly, 'data-passkey-only': '', onchange: async (e) => {
    const on = e.target.checked;
    if (on && !(await confirmDialog(t('Nur mit Passkey'), t('Danach öffnet sich der Tresor nur noch mit einem Passkey oder Sicherheitsschlüssel, nicht mehr mit dem Masterpasswort der App. Alle Masterpasswort-Zugänge werden aus der Datei entfernt; jedes Mitglied braucht vorher einen Passkey.'), { confirmLabel: t('Einschalten') }))) {
      e.target.checked = false;
      return;
    }
    op({ type: 'passkeyOnly', enabled: on }, on ? t('Nur noch mit Passkey') : t('Auch mit Masterpasswort'));
  } });
  return h('label', { class: 'inline' }, box, t('Nur mit Passkey (für sensible Tresore)'));
}

/** Members view: a request that replaces a member (master password compromised) – approved in one step. */
export function replacementRow(m, rep, op) {
  const code = codeInput(); // #539 Etappe 10: typed by the admin, read out by the person
  return h('div', { class: 'member-row', 'data-replacement': m.id },
    h('div', { class: 'grow' }, h('b', {}, m.email), h('span', { class: 'badge warn' }, t('neue Identität')),
      h('div', { class: 'muted small' }, t('Ersetzt {email} – Masterpasswort kompromittiert. Lass dir den Sicherheitscode vorlesen und tippe ihn ein.', { email: rep.email })), code),
    h('button', { class: 'btn small primary', onclick: async () => {
      if (!(await confirmDialog(t('Neu freigeben'), t('Die neue Identität von {email} bekommt die bisherige Rolle, die alte wird entfernt und die Datei bekommt einen neuen Schlüssel.', { email: rep.email }), { confirmLabel: t('Neu freigeben') }))) return;
      op({ type: 'replace', memberId: m.id, code: code.value }, t('{email} neu freigegeben – Schlüssel gewechselt', { email: rep.email }));
    } }, t('Neu freigeben')),
    h('button', { class: 'btn small', onclick: () => op({ type: 'reject', memberId: m.id }, t('Anfrage abgelehnt')) }, t('Ablehnen')));
}

/** Members view: link the own identity to the master password (if not yet, and allowed). */
export function linkButton(info, op) {
  const me = info.members.find((m) => m.me);
  if (!me || me.app || info.passkeyOnly || info.passkeyOnlyPolicy) return null;
  return h('button', { class: 'btn small', 'data-member-link': '', onclick: () => op({ type: 'addAppCredential' }, t('Mit dem Masterpasswort verbunden')) }, t('Mit Masterpasswort verbinden'));
}

/** Label of one of the own credentials. */
export const credentialLabel = (cred) => (cred.kind === 'app' ? t('Masterpasswort der App') : cred.label || t('Passkey'));

/** Key change of the personal vault: the option "master password compromised" and what follows it. */
export function compromisedOption({ preselect = false } = {}) {
  const box = h('input', { type: 'checkbox', 'data-mp-compromised': '', checked: preselect });
  const element = h('div', { class: 'field' },
    h('label', { class: 'inline' }, box, t('Mein Masterpasswort ist kompromittiert: Mitgliedschaften in geteilten Tresoren erneuern')),
    h('p', { class: 'muted small' }, t('Du bekommst in jedem abgesicherten Datei-Tresor eine neue Identität. Bist du dort Admin, gilt sie sofort; sonst gibt ein Admin sie nach dem Vergleich des Sicherheitscodes neu frei. Tresore, die gerade nicht geöffnet werden können, folgen beim nächsten Öffnen.')));
  return {
    element,
    checked: () => box.checked,
    after: async () => {
      if (!box.checked) return;
      try {
        showRenewResult(await call('renewMemberIdentity'));
      } catch (e) {
        toast(e.message, 'error');
      }
    },
  };
}

function showRenewResult(list) {
  if (!list.length) {
    toast(t('Keine geteilten Tresore mit Masterpasswort-Zugang'));
    return;
  }
  modal(t('Mitgliedschaften erneuert'), h('div', { 'data-renew-result': '' },
    h('p', { class: 'muted small' }, t('Tresore, die hier nicht aufgeführt sind, bekommen die neue Identität beim nächsten Öffnen mit dem Masterpasswort.')),
    ...list.map((x) => (x.error ? notice(t('{name}: übersprungen – {error}', { name: x.name, error: x.error }))
      : h('p', {}, x.replaced ? t('{name}: neue Identität gilt (du bist Admin), Schlüssel gewechselt.', { name: x.name })
        : t('{name}: wartet auf die Neufreigabe durch einen Admin. Sicherheitscode: {code}', { name: x.name, code: x.safetyCode }))))));
}
