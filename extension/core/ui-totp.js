// One-time code secret (TOTP) in the item editor (#469): once set, nobody can display it again – it can only be
// replaced ("Erneuern") or removed. The stored secret lives in this closure only: never in an input's value, a data
// attribute or a hidden field, so it can't be read off the page or phished. Codes are calculated as before.

import { h, icon, iconButton, toast, setChildren } from './dom.js';
import { parseTotp } from './totp.js';
import { t } from './i18n.js';

/** What the editor knows about a stored secret: only whether one is set. Pure, for the unit test. */
export const totpEditModel = (stored) => ({ set: !!String(stored || '').trim() });

/**
 * The secret to save. "keep" (the default) keeps the stored one, "remove" clears it, "replace" takes the new input –
 * an empty replace field keeps the stored secret instead of deleting it. Pure, for the unit test.
 * @param {string} stored
 * @param {{ mode?: 'keep'|'replace'|'remove', input?: string }} [choice]
 */
export function resolveTotp(stored, choice = {}) {
  const kept = String(stored || '');
  if (choice.mode === 'remove') return '';
  if (choice.mode === 'replace') return String(choice.input || '').trim() || kept;
  return kept;
}

/**
 * Editor for one TOTP secret. Without a stored secret: an input (plus QR scan). With one: "gesetzt", "Erneuern" and
 * "Entfernen". The returned value() is what to save; check() validates a newly entered secret (error text or '').
 * @param {string} stored
 * @param {{ name?: string, scanQr?: () => Promise<string>, onChange?: () => void }} [opts]
 */
export function totpEditor(stored, opts = {}) {
  const { set } = totpEditModel(stored);
  let mode = set ? 'keep' : 'replace';
  const changed = () => opts.onChange?.();
  const input = h('input', { name: opts.name, type: 'password', placeholder: t('otpauth://… oder Base32-Geheimnis'), autocomplete: 'off', spellcheck: 'false', oninput: changed });
  // Reveals only what was typed or scanned in this form, never the stored secret (that is not in the input).
  const reveal = iconButton('eye', t('Anzeigen'), () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    reveal.replaceChildren(icon(input.type === 'password' ? 'eye' : 'eyeOff'));
  });
  // ctx.scanQr() (browser extension): reads the QR code the website shows when setting up two-factor sign-in.
  const scan = opts.scanQr ? iconButton('qr', t('QR-Code auf der Seite scannen'), async () => {
    scan.disabled = true;
    try {
      const text = await opts.scanQr();
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
      input.value = text;
      changed();
      toast(t('Einmalcode aus QR-Code übernommen'));
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      scan.disabled = false;
    }
  }) : null;
  const el = h('div', { class: 'field-row totp-editor' });
  const to = (next) => {
    mode = next;
    input.value = '';
    input.type = 'password';
    reveal.replaceChildren(icon('eye'));
    draw();
    changed();
    if (mode === 'replace') setTimeout(() => input.focus(), 0);
  };
  const button = (cls, iconName, label, onclick) => h('button', { type: 'button', class: `btn small ${cls}`, onclick }, iconName ? icon(iconName, 14) : null, label);
  const draw = () => {
    el.dataset.totpState = mode;
    if (mode === 'keep') {
      setChildren(el, h('span', { class: 'value totp-set' }, icon('check', 14), ` ${t('gesetzt')}`),
        button('totp-renew', 'refresh', t('Erneuern'), () => to('replace')),
        button('totp-remove', 'trash', t('Entfernen'), () => to('remove')));
    } else if (mode === 'remove') {
      setChildren(el, h('span', { class: 'muted small totp-removed' }, t('Wird beim Speichern entfernt.')),
        button('totp-undo', null, t('Rückgängig'), () => to('keep')));
    } else {
      setChildren(el, input, reveal, scan, set ? button('totp-cancel', null, t('Abbrechen'), () => to('keep')) : null);
    }
  };
  draw();
  return {
    el,
    value: () => resolveTotp(stored, { mode, input: input.value }),
    check: () => {
      if (mode !== 'replace' || !input.value.trim()) return '';
      try {
        parseTotp(input.value);
        return '';
      } catch (e) {
        return e.message;
      }
    },
    focus: () => input.focus(),
  };
}
