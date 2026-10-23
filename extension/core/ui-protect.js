// Protection UI shared by the extension and the desktop app: unlock panel, setup (master password and/or
// passkey), recovery key, management (passkeys of several users, invitations, password change).
//
// ctx (client-specific, all async):
//   info(id) → { kind, protected, locked, methods, passkeys }       unlock(id, { password } | { code }) → { via, entryId }
//   unlockPasskey(id) → { via, entryId }                             enable(id, { password, passkeyLabel }) → { recoveryKey, failed }
//   update(id, op) → { recoveryKey?, inviteCode?, expires? }          addPasskey(id, label)
//   disable(id) → { failed }                                         lock(id)
//   passkeyAvailable (bool), clientName (string), defaultLabel (string)

import { h, icon, modal, toast, confirmDialog, formatDateTime, setChildren, iconButton } from './dom.js';
import { passwordStrength } from './generator.js';
import { t } from './i18n.js';

const notice = (text, kind = 'info') => h('div', { class: `notice ${kind}` }, text);

function busy(button, label, fn) {
  return async (...args) => {
    const original = [...button.childNodes];
    button.disabled = true;
    button.replaceChildren(h('span', { class: 'spinner' }), label);
    try {
      return await fn(...args);
    } catch (e) {
      toast(e.message, 'error');
      return undefined;
    } finally {
      button.disabled = false;
      button.replaceChildren(...original);
    }
  };
}

/** Form part for choosing master password and/or passkey. read() → { password, passkeyLabel } or throws. */
export function methodsForm(ctx, { requirePasskeyHint = false } = {}) {
  const usePassword = h('input', { type: 'checkbox', checked: !ctx.passkeyAvailable });
  const usePasskey = h('input', { type: 'checkbox', checked: !!ctx.passkeyAvailable, disabled: !ctx.passkeyAvailable });
  const pw1 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: t('mindestens 8 Zeichen') });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: t('wiederholen') });
  const meter = h('div', { class: 'strength' }, h('span'), h('em'));
  pw1.addEventListener('input', () => {
    const s = passwordStrength(pw1.value);
    meter.dataset.level = String(s.level);
    meter.querySelector('em').textContent = s.label;
  });
  const label = h('input', { value: ctx.defaultLabel || '', placeholder: t('z. B. Alex – YubiKey') });
  const pwBox = h('div', { class: 'indent' }, h('div', { class: 'grid2' }, pw1, pw2), meter);
  const pkBox = h('div', { class: 'indent' }, h('div', { class: 'field' }, h('label', {}, t('Bezeichnung des Passkeys')), label),
    h('p', { class: 'muted small' }, t('Beim Speichern fragt {client} nach dem Passkey (Sicherheitsschlüssel, Windows Hello oder Smartphone).', { client: ctx.clientName })));
  const sync = () => {
    pwBox.hidden = !usePassword.checked;
    pkBox.hidden = !usePasskey.checked;
  };
  usePassword.addEventListener('change', sync);
  usePasskey.addEventListener('change', sync);
  sync();
  const element = h('div', {},
    h('label', { class: 'inline' }, usePasskey, h('b', {}, t('Passkey'))),
    ctx.passkeyAvailable ? pkBox : h('p', { class: 'muted small indent' }, t('Passkeys sind in dieser App auf diesem System nicht verfügbar.')),
    h('label', { class: 'inline', style: { marginTop: '10px' } }, usePassword, h('b', {}, t('Masterpasswort'))),
    pwBox,
    requirePasskeyHint ? h('p', { class: 'muted small' }, t('Jede Methode entsperrt für sich. Weitere Benutzer fügst du später mit einer Einladung hinzu.')) : null);
  return {
    element,
    read() {
      const out = {};
      if (usePassword.checked) {
        if (pw1.value.length < 8) throw new Error(t('Das Masterpasswort muss mindestens 8 Zeichen lang sein'));
        if (pw1.value !== pw2.value) throw new Error(t('Die Passwörter stimmen nicht überein'));
        out.password = pw1.value;
      }
      if (usePasskey.checked && ctx.passkeyAvailable) out.passkeyLabel = label.value.trim() || ctx.defaultLabel || t('Passkey');
      if (!out.password && !out.passkeyLabel) throw new Error(t('Bitte ein Masterpasswort und/oder einen Passkey festlegen'));
      return out;
    },
  };
}

/** Shows a recovery key or invitation code; the user has to confirm before closing. */
export function showCode(title, code, text, confirmText) {
  return new Promise((resolve) => {
    const confirm = h('input', { type: 'checkbox' });
    const done = h('button', { type: 'button', class: 'btn primary', disabled: true }, t('Fertig'));
    confirm.addEventListener('change', () => { done.disabled = !confirm.checked; });
    const { dialog, close } = modal(title, h('div', {},
      h('p', {}, text),
      h('div', { class: 'code-box' }, h('code', {}, code), iconButton('copy', t('Kopieren'), () => navigator.clipboard.writeText(code).then(() => toast(t('Kopiert'))))),
      h('label', { class: 'inline', style: { marginTop: '12px' } }, confirm, confirmText)), []);
    done.addEventListener('click', () => {
      close();
      resolve();
    });
    dialog.querySelector('.modal-footer').append(done);
    dialog.addEventListener('close', () => resolve());
  });
}

export const showRecoveryKey = (code) => showCode(t('Wiederherstellungsschlüssel'), code,
  t('Mit diesem Schlüssel entsperrst du den Tresor, wenn Passkey oder Masterpasswort verloren sind. Er wird nur jetzt angezeigt – drucke ihn aus oder lege ihn an einem sicheren Ort ab.'),
  t('Ich habe den Schlüssel sicher aufbewahrt'));

/** After unlocking with an invitation: register the own passkey (or password) and consume the invitation. */
async function completeInvite(container, ctx, entryId) {
  const form = methodsForm(ctx);
  await new Promise((resolve) => {
    modal(t('Willkommen in „{name}“', { name: container.name }), h('div', {},
      h('p', {}, t('Lege jetzt deine eigene Entsperrmethode fest. Die Einladung wird danach entfernt.')), form.element), [
      { label: t('Später'), onClick: () => resolve() },
      { label: t('Speichern'), primary: true, onClick: async () => {
        const m = form.read();
        if (m.passkeyLabel) await ctx.addPasskey(container.id, m.passkeyLabel);
        if (m.password) await ctx.update(container.id, { type: 'setPassword', password: m.password });
        await ctx.update(container.id, { type: 'removeEntry', entryId });
        toast(t('Entsperrmethode gespeichert'));
        resolve();
      } },
    ]);
  });
}

/** Panel shown for a locked container. onUnlocked() is called after success. */
export function unlockPanel(container, info, ctx, onUnlocked) {
  const methods = info.methods || { passkeys: [], password: false };
  const usable = methods.passkeys.filter((p) => p.usable);
  const after = async (r) => {
    toast(t('Entsperrt'));
    if (r?.via === 'invite') await completeInvite(container, ctx, r.entryId);
    onUnlocked?.();
  };
  const parts = [h('div', { class: 'unlock-head' }, icon('lock', 28), h('div', {},
    h('h3', {}, t('„{name}“ ist geschützt', { name: container.name })),
    h('div', { class: 'muted small' }, container.kind === 'keyvault' ? t('Zusätzlich verschlüsselter Key-Vault-Tresor') : t('Datei-Tresor')))) ];
  if (info.secure) {
    // Secured files are bound to passkeys of the desktop app.
    parts.push(h('p', { class: 'muted' }, t('Diese Datei lässt sich nur in der Desktop-App mit Passkey oder Windows Hello entsperren. Danach steht sie hier zur Verfügung.')));
    return h('div', { class: 'unlock-panel' }, ...parts);
  }

  if (usable.length && ctx.passkeyAvailable) {
    const b = h('button', { type: 'button', class: 'btn primary block' }, icon('key'), t('Mit Passkey entsperren'));
    b.addEventListener('click', busy(b, t('Passkey bestätigen …'), async () => after(await ctx.unlockPasskey(container.id))));
    parts.push(b);
  } else if (methods.passkeys.length) {
    parts.push(notice(t('Die Passkeys dieses Tresors sind für eine andere App registriert. Entsperre mit Masterpasswort, Wiederherstellungsschlüssel oder Einladungscode und füge danach hier einen Passkey hinzu.')));
  }
  if (methods.password) {
    const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: t('Masterpasswort') });
    const b = h('button', { type: 'submit', class: 'btn' + (usable.length && ctx.passkeyAvailable ? '' : ' primary') }, t('Entsperren'));
    const form = h('form', { class: 'field-row' }, pw, b);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(b, t('Prüfen …'), async () => after(await ctx.unlock(container.id, { password: pw.value })))();
    });
    parts.push(form);
    if (!(usable.length && ctx.passkeyAvailable)) setTimeout(() => pw.focus(), 0);
  }
  const code = h('input', { placeholder: 'RK-… / IN-…', autocomplete: 'off', spellcheck: 'false' });
  const codeButton = h('button', { type: 'submit', class: 'btn' }, t('Entsperren'));
  const codeForm = h('form', { class: 'field-row', hidden: true }, code, codeButton);
  codeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(codeButton, t('Prüfen …'), async () => after(await ctx.unlock(container.id, { code: code.value })))();
  });
  parts.push(h('button', { type: 'button', class: 'linklike small', onclick: () => {
    codeForm.hidden = !codeForm.hidden;
    if (!codeForm.hidden) code.focus();
  } }, t('Wiederherstellungsschlüssel oder Einladungscode verwenden')), codeForm);
  return h('div', { class: 'unlock-panel' }, ...parts);
}

/** Turns on the extra protection for a Key Vault container. */
export function enableDialog(container, ctx, onDone) {
  const form = methodsForm(ctx, { requirePasskeyHint: true });
  modal(t('„{name}“ zusätzlich schützen', { name: container.name }), h('div', {},
    h('p', {}, t('Die Einträge werden vor dem Speichern in Azure verschlüsselt. Ohne Masterpasswort, Passkey oder Wiederherstellungsschlüssel kann sie niemand lesen – auch kein Azure-Administrator.')),
    notice(t('Vorhandene Einträge werden verschlüsselt neu angelegt. Die alten, unverschlüsselten Fassungen bleiben bis zum Ende der Aufbewahrungsfrist im gelöschten Zustand im Key Vault, wenn der Löschschutz aktiv ist.'), 'warn'),
    form.element), [
    { label: t('Abbrechen') },
    { label: t('Schutz einschalten'), primary: true, onClick: async () => {
      const m = form.read();
      toast(t('Einträge werden verschlüsselt …'));
      const r = await ctx.enable(container.id, m);
      await showRecoveryKey(r.recoveryKey);
      if (r.failed?.length) modal(t('Nicht verschlüsselt'), h('pre', { class: 'errors' }, r.failed.join('\n')));
      onDone?.();
    } },
  ]);
}

/** Management of methods and users of a protected, unlocked container. */
export async function manageDialog(container, ctx, onChange) {
  const body = h('div', {});
  const refresh = async () => {
    const info = await ctx.info(container.id);
    const m = info.methods;
    const passkeyRows = m.passkeys.map((p) => h('div', { class: 'member' }, icon('key'),
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title' }, p.label || t('Passkey'), p.usable ? null : h('span', { class: 'badge' }, t('andere App'))),
        h('div', { class: 'row-sub' }, [p.createdBy, formatDateTime(p.created)].filter(Boolean).join(' · '))),
      iconButton('trash', t('Passkey entfernen'), async () => {
        if (!(await confirmDialog(t('Passkey entfernen'), t('„{label}“ kann den Tresor danach nicht mehr entsperren.', { label: p.label || t('Passkey') }), { confirmLabel: t('Entfernen'), danger: true }))) return;
        await ctx.update(container.id, { type: 'removeEntry', entryId: p.id }).catch((e) => toast(e.message, 'error'));
        refresh();
      })));
    const inviteRows = m.invites.map((i) => h('div', { class: 'member' }, icon('users'),
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title' }, i.label || t('Einladung'), i.expired ? h('span', { class: 'badge warn' }, t('abgelaufen')) : null),
        h('div', { class: 'row-sub' }, t('gültig bis {date}', { date: formatDateTime(i.expires) }))),
      iconButton('trash', t('Einladung zurückziehen'), async () => {
        await ctx.update(container.id, { type: 'removeEntry', entryId: i.id }).catch((e) => toast(e.message, 'error'));
        refresh();
      })));
    const addPasskey = h('button', { type: 'button', class: 'btn', disabled: !ctx.passkeyAvailable }, icon('key'), t('Passkey hinzufügen'));
    addPasskey.addEventListener('click', busy(addPasskey, t('Passkey bestätigen …'), async () => {
      await ctx.addPasskey(container.id, ctx.defaultLabel || t('Passkey'));
      toast(t('Passkey hinzugefügt'));
      refresh();
    }));
    const invite = h('button', { type: 'button', class: 'btn' }, icon('users'), t('Benutzer einladen'));
    invite.addEventListener('click', async () => {
      const name = h('input', { placeholder: t('z. B. Kim') });
      modal(t('Benutzer einladen'), h('div', {},
        h('p', {}, t('Der Einladungscode entsperrt den Tresor einmalig, danach legt die eingeladene Person ihren eigenen Passkey oder ihr eigenes Masterpasswort fest. Gib den Code auf einem sicheren Weg weiter (nicht zusammen mit der Datei).')),
        h('div', { class: 'field' }, h('label', {}, t('Für wen?')), name)), [
        { label: t('Abbrechen') },
        { label: t('Code erzeugen'), primary: true, onClick: async () => {
          const r = await ctx.update(container.id, { type: 'createInvite', label: name.value.trim(), days: 7 });
          refresh();
          setTimeout(() => showCode(t('Einladungscode'), r.inviteCode,
            t('Gültig bis {date}. {extra}', { date: formatDateTime(r.expires), extra: container.kind === 'keyvault' ? t('Zusätzlich braucht die Person Zugriff auf den Key Vault (Freigabe).') : t('Die Person braucht außerdem Zugriff auf die Datei.') }),
            t('Ich habe den Code weitergegeben')), 0);
        } },
      ]);
    });
    const password = h('button', { type: 'button', class: 'btn' }, icon('lock'), m.password ? t('Masterpasswort ändern') : t('Masterpasswort festlegen'));
    password.addEventListener('click', () => {
      const pw1 = h('input', { type: 'password', autocomplete: 'new-password' });
      const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
      modal(m.password ? t('Masterpasswort ändern') : t('Masterpasswort festlegen'), h('div', {},
        h('div', { class: 'field' }, h('label', {}, t('Neues Masterpasswort')), pw1),
        h('div', { class: 'field' }, h('label', {}, t('Wiederholen')), pw2)), [
        { label: t('Abbrechen') },
        { label: t('Speichern'), primary: true, onClick: async () => {
          if (pw1.value !== pw2.value) throw new Error(t('Die Passwörter stimmen nicht überein'));
          await ctx.update(container.id, { type: 'setPassword', password: pw1.value });
          toast(t('Masterpasswort gespeichert'));
          refresh();
        } },
      ]);
    });
    const removePassword = m.password && (m.passkeys.length || m.recovery) ? h('button', { type: 'button', class: 'btn', onclick: async () => {
      const entry = (await ctx.info(container.id)).methods;
      if (!(await confirmDialog(t('Masterpasswort entfernen'), t('Danach entsperren nur noch Passkeys und der Wiederherstellungsschlüssel.'), { confirmLabel: t('Entfernen'), danger: true }))) return;
      await ctx.update(container.id, { type: 'removeEntry', entryId: entry.passwordId }).catch((e) => toast(e.message, 'error'));
      refresh();
    } }, t('Masterpasswort entfernen')) : null;
    const recovery = h('button', { type: 'button', class: 'btn' }, icon('refresh'), t('Neuer Wiederherstellungsschlüssel'));
    recovery.addEventListener('click', async () => {
      if (!(await confirmDialog(t('Neuer Wiederherstellungsschlüssel'), t('Der bisherige Wiederherstellungsschlüssel wird dabei ungültig.'), { confirmLabel: t('Erzeugen') }))) return;
      const r = await ctx.update(container.id, { type: 'newRecovery' }).catch((e) => toast(e.message, 'error'));
      if (r?.recoveryKey) await showRecoveryKey(r.recoveryKey);
      refresh();
    });
    setChildren(body,
      h('h3', {}, t('Passkeys')),
      passkeyRows.length ? passkeyRows : h('p', { class: 'muted' }, t('Noch kein Passkey.')),
      h('div', { class: 'actions' }, addPasskey, invite),
      inviteRows.length ? [h('h3', {}, t('Offene Einladungen')), inviteRows] : null,
      h('h3', {}, t('Weitere Methoden')),
      h('p', { class: 'muted small' }, [m.password ? t('Masterpasswort eingerichtet') : t('Kein Masterpasswort'), m.recovery ? t('Wiederherstellungsschlüssel vorhanden') : t('Kein Wiederherstellungsschlüssel')].join(' · ')),
      h('div', { class: 'actions' }, password, removePassword, recovery),
      container.kind === 'keyvault' ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog(t('Schutz ausschalten'), t('Alle Einträge werden wieder unverschlüsselt im Key Vault gespeichert. Zugriff regelt dann nur noch Azure RBAC.'), { confirmLabel: t('Schutz ausschalten'), danger: true }))) return;
        const r = await ctx.disable(container.id).catch((e) => toast(e.message, 'error'));
        if (r?.failed?.length) modal(t('Nicht entschlüsselt'), h('pre', { class: 'errors' }, r.failed.join('\n')));
        else if (r) {
          toast(t('Schutz ausgeschaltet'));
          close();
          onChange?.();
        }
      } }, t('Schutz ausschalten'))) : null);
  };
  const { close } = modal(t('Schutz von „{name}“', { name: container.name }), body, [
    { label: t('Jetzt sperren'), onClick: async () => { await ctx.lock(container.id); onChange?.(); } },
    { label: t('Schließen'), onClick: () => onChange?.() },
  ]);
  body.append(h('span', { class: 'spinner' }));
  await refresh().catch((e) => setChildren(body, notice(e.message, 'error')));
}
