// The personal vault: wizard, first start, PIN prompt.

import { h, icon, toast, modal } from '../../../extension/core/dom.js';
import { manageDialog, showRecoveryKey, strengthMeter } from '../../../extension/core/ui-protect.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { setSt, st } from './state.js';
import { field, notice } from './helpers.js';
import { protectCtx } from './protection.js';
import { fetchState, reloadAll, render } from './shell.js';
import { REMOTE_KINDS, select, syncState } from './sidebar.js';
import { vaultWizard } from './vault-wizard.js';

/**
 * Wizard for the personal vault: what it is → where it lives (OneDrive found automatically, or another synced folder /
 * network drive; an existing vault there can be used) → master password and app PIN → optional FIDO key → recovery
 * key. The vault is free and for one person only.
 */
export async function personalWizard() {
  const s = { step: 0, info: null, mode: 'create', id: null, recoveryKey: null };
  const body = h('div', { class: 'wizard' });
  const { dialog, close } = modal(t('Persönlicher Tresor'), body, []);
  dialog.classList.add('wizard-modal');
  const closed = new Promise((resolve) => dialog.addEventListener('close', resolve));
  const steps = [t('Start'), t('Speicherort'), t('Schutz'), t('FIDO-Stick'), t('Fertig')];
  const header = () => h('ol', { class: 'wizard-steps' }, ...steps.map((label, i) => h('li', { class: i === s.step ? 'on' : i < s.step ? 'done' : '' }, h('span', {}, String(i + 1)), label)));
  const buttons = (...b) => h('div', { class: 'wizard-buttons' }, ...b);
  const btn = (label, onClick, { primary = false, disabled = false } = {}) => h('button', { type: 'button', class: primary ? 'btn primary' : 'btn', disabled, onclick: async (e) => {
    const el = e.currentTarget;
    el.disabled = true;
    try { await onClick(); } catch (err) { toast(err.message, 'error'); } finally { el.disabled = false; }
  } }, label);
  const go = (step) => { s.step = step; draw(); };
  const locationLine = (info) => {
    const loc = info?.location;
    if (!info?.folder) return notice(t('Kein OneDrive gefunden. Richte OneDrive ein oder wähle einen anderen synchronisierten Ordner bzw. ein Netzlaufwerk.'), 'warn');
    if (!loc || !REMOTE_KINDS.includes(loc.kind)) return notice(t('Dieser Ordner liegt lokal auf dem Gerät – bitte einen synchronisierten Ordner oder ein Netzlaufwerk wählen.'), 'warn');
    const what = loc.kind === 'cloud' ? loc.provider || t('Cloud-Ordner') : t('Netzlaufwerk');
    const s = syncState(loc);
    const state = s.level === 'ok' || !s.text ? t('bereit') : s.text;
    return notice(t('{what} · {state}', { what, state }), s.level === 'problem' ? 'warn' : 'info');
  };
  const pinFields = () => st.pinSet
    ? { el: field(t('App-PIN'), h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'wiz-pin' })), pin: () => body.querySelector('.wiz-pin').value, repeat: null }
    : { el: h('div', { class: 'grid2' },
      field(t('Neue App-PIN'), h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'wiz-pin' })),
      field(t('Wiederholen'), h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'wiz-pin2' }))),
    pin: () => body.querySelector('.wiz-pin').value, repeat: () => body.querySelector('.wiz-pin2').value };
  const ensurePin = async (pf) => {
    if (st.pinSet) return pf.pin();
    if (pf.pin() !== pf.repeat()) throw new Error(t('Die PINs stimmen nicht überein'));
    await call('setPin', { current: null, next: pf.pin() });
    setSt(await fetchState());
    return pf.pin();
  };

  const draw = async () => {
    let content;
    if (s.step === 0) {
      content = [
        h('p', {}, t('Ein kostenloser Tresor nur für dich: verschlüsselt in deinem OneDrive (oder einem anderen synchronisierten Ordner bzw. auf einem Netzlaufwerk) und auf jedem deiner Geräte verfügbar.')),
        h('ul', { class: 'wizard-points' },
          h('li', {}, t('Verschlüsselt mit deinem Masterpasswort – niemand sonst kann ihn öffnen, auch kein Admin.')),
          h('li', {}, t('Im Alltag entsperrst du mit deiner App-PIN; optional zusätzlich mit einem FIDO-Stick.')),
          h('li', {}, t('Nicht teilbar und ohne Lizenz.')),
          h('li', {}, t('Mehr Ordnung (z. B. privat und geschäftlich): Ordner im persönlichen Tresor anlegen.'))),
        buttons(btn(t('Abbrechen'), () => close()), btn(t('Weiter'), async () => { s.info = await call('personalInfo'); go(1); }, { primary: true })),
      ];
    } else if (s.step === 1) {
      const info = s.info;
      const ok = info?.folder && info.location && REMOTE_KINDS.includes(info.location.kind);
      content = [
        h('p', {}, t('Speicherort der Datei:')),
        h('div', { class: 'wizard-path' }, icon('folder', 16), h('code', {}, info?.path || '–')),
        locationLine(info),
        info?.exists ? h('div', { class: 'wizard-choice' },
          h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'pmode', checked: s.mode === 'use', onchange: () => { s.mode = 'use'; } }), t('Bestehenden Tresor verwenden (dort liegt schon einer)')),
          h('label', { class: 'inline muted' }, h('input', { type: 'radio', name: 'pmode', disabled: true }), t('Neu erstellen – dafür einen anderen Ordner wählen'))) : null,
        buttons(
          btn(t('Zurück'), () => go(0)),
          btn(t('Anderen Ordner wählen …'), async () => { const r = await call('choosePersonalFolder'); if (r) { s.info = r; s.mode = r.exists ? 'use' : 'create'; draw(); } }),
          btn(t('Weiter'), () => { s.mode = info.exists ? 'use' : 'create'; go(2); }, { primary: true, disabled: !ok })),
      ];
    } else if (s.step === 2) {
      const pw = h('input', { type: 'password', autocomplete: 'new-password' });
      const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
      const pf = pinFields();
      content = s.mode === 'create' ? [
        h('p', {}, t('Das Masterpasswort verschlüsselt den Tresor. Wähle es lang und einzigartig (mindestens 12 Zeichen) – du brauchst es auf neuen Geräten und zum Ändern der PIN.')),
        h('div', { class: 'grid2' }, field(t('Masterpasswort'), pw), field(t('Wiederholen'), pw2)),
        strengthMeter(pw),
        h('p', { class: 'muted small' }, st.pinSet ? t('Deine App-PIN entsperrt den Tresor auf diesem Gerät.') : t('Lege eine App-PIN fest – sie entsperrt den Tresor auf diesem Gerät.')),
        pf.el,
        buttons(btn(t('Zurück'), () => go(1)), btn(t('Tresor erstellen'), async () => {
          if (pw.value.length < 12) throw new Error(t('Das Masterpasswort braucht mindestens 12 Zeichen'));
          if (pw.value !== pw2.value) throw new Error(t('Die Passwörter stimmen nicht überein'));
          const pin = await ensurePin(pf);
          const r = await call('createPersonal', { folder: s.info.folder, password: pw.value, pin });
          s.id = r.id;
          s.recoveryKey = r.recoveryKey;
          await reloadAll();
          go(3);
        }, { primary: true })),
      ] : [
        h('p', {}, t('Entsperre den vorhandenen Tresor einmal mit seinem Masterpasswort. Danach reicht auf diesem Gerät deine App-PIN.')),
        field(t('Masterpasswort'), pw),
        pf.el,
        buttons(btn(t('Zurück'), () => go(1)), btn(t('Verwenden und entsperren'), async () => {
          const pin = await ensurePin(pf);
          const r = await call('usePersonal', { folder: s.info.folder });
          s.id = r.id;
          await call('unlockContainer', r.id, { password: pw.value });
          await call('bindPersonalWithPin', pin);
          await reloadAll();
          go(3);
        }, { primary: true })),
      ];
    } else if (s.step === 3) {
      content = [
        h('p', {}, t('Optional: Ein FIDO-Stick (z. B. YubiKey) kann den Tresor zusätzlich zum Masterpasswort entsperren – praktisch auf neuen Geräten. Der Stick muss „PRF“ (hmac-secret) unterstützen.')),
        buttons(
          btn(t('Überspringen'), () => go(4)),
          btn(t('FIDO-Stick hinzufügen …'), async () => {
            const c = st.containers.find((x) => x.id === s.id);
            if (c) await manageDialog(c, protectCtx, () => reloadAll());
          }, { primary: true }),
          btn(t('Weiter'), () => go(4))),
      ];
    } else {
      content = [
        h('p', {}, t('Der persönliche Tresor ist eingerichtet und steht ganz oben in der Seitenleiste.')),
        s.recoveryKey ? h('p', {}, t('Bewahre jetzt den Wiederherstellungsschlüssel sicher auf (ausdrucken, nicht im selben Tresor) – ohne ihn sind die Daten verloren, wenn du das Masterpasswort vergisst.')) : null,
        buttons(
          s.recoveryKey ? btn(t('Wiederherstellungsschlüssel anzeigen'), () => showRecoveryKey(s.recoveryKey)) : null,
          btn(t('Fertig'), () => { close(); if (s.id) select({ view: 'container', containerId: s.id }); }, { primary: true })),
      ];
    }
    body.replaceChildren(header(), ...[content].flat().filter(Boolean));
  };
  draw();
  return closed;
}

export async function firstStartWizards({ always = false } = {}) {
  await personalWizard();
  await call('syncSettings').catch(() => null);
  setSt(await fetchState());
  if (document.querySelector('dialog[open]')) return render();
  if (!always && (st.containers.some((c) => c.kind === 'keyvault') || st.settings.containers.length)) return render();
  await vaultWizard();
  return render();
}

/** After the personal vault was opened with its master password on this device: bind it to the PIN. */
export function personalPinPrompt() {
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off' });
  modal(t('Mit PIN entsperren'), h('div', {},
    h('p', {}, t('Gib deine App-PIN ein – dann entsperrt sie den persönlichen Tresor auf diesem Gerät, ohne Masterpasswort.')),
    field(t('App-PIN'), pin)), [
    { label: t('Später') },
    { label: t('Übernehmen'), primary: true, onClick: async () => { await call('bindPersonalWithPin', pin.value); toast(t('Persönlicher Tresor mit PIN verbunden')); } },
  ]);
  setTimeout(() => pin.focus(), 0);
}
