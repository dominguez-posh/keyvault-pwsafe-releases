// #539 Etappe 10 in the window: the break-glass stick of secured file vaults and approving requests by the typed code.
// The rules live in the main process (desktop/main/break-glass.js, extension/core/members-mp.js).

import { h, icon } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';

export const BREAK_GLASS_HINT = 'Pflicht: Nach deiner Anmeldung richtest du einen FIDO-Sicherheitsschlüssel als Notfall-Zugang (Break-Glass) ein – zweimal berühren: einmal zum Einrichten, einmal zum Testen. Bewahre ihn sicher auf (z. B. im Safe): Mit ihm lassen sich die Daten öffnen, auch wenn kein Admin mehr erreichbar ist. Er muss ein anderer Stick sein als dein eigener Passkey.';

/** Field for the code the person reads out from their own app (the admin never sees it before). */
export function codeInput() {
  return h('input', { class: 'safety-code-input', inputmode: 'numeric', autocomplete: 'off', placeholder: t('Sicherheitscode (16 Ziffern)'), 'aria-label': t('Sicherheitscode, den dir die Person vorliest'), 'data-safety-code': '' });
}

/** Badge of a break-glass member. */
export const breakGlassBadge = (m) => (m.breakGlass ? h('span', { class: 'badge warn', 'data-break-glass': '' }, icon('key', 12), t('Notfall-Zugang')) : null);

/** Admin: another emergency stick. op(o, message) runs the member operation. */
export function addBreakGlassButton(op) {
  return h('button', { class: 'btn small', 'data-add-break-glass': '', onclick: () => op({ type: 'breakGlass' }, t('Notfall-Stick hinzugefügt')) }, icon('key', 14), t('Notfall-Stick hinzufügen'));
}

/** Is this member the last active break-glass access? (Removal is refused anyway – the button says why.) */
export const lastBreakGlass = (info, m) => !!m.breakGlass && info.members.filter((x) => x.breakGlass && x.status === 'active').length <= 1;
