// The personal vault: wizard, first start, PIN prompt.

import { h, icon, toast, modal } from '../../../extension/core/dom.js';
import { codeConfirm, manageDialog, showCode, strengthMeter } from '../../../extension/core/ui-protect.js';
import { t } from '../../../extension/core/i18n.js';
import { KEY_CHANGE } from '../../../extension/core/protect.js';
import { call } from './ipc.js';
import { setSt, st } from './state.js';
import { field, notice } from './helpers.js';
import { protectCtx } from './protection.js';
import { fetchState, reloadAll, render } from './shell.js';
import { REMOTE_KINDS, select, syncState } from './sidebar.js';
import { vaultWizard } from './vault-wizard.js';
import { focusField } from './focus.js';
import { firstStartSettings } from './settings-file.js';
import { accountStepsDue, accountWizard } from './first-start.js';

// Asked for the unconfirmed recovery key once per unlock; afterwards the notice in the sidebar stays (#399).
let recoveryAsked = false;
let recoveryBusy = false;

/**
 * Wizard for the personal vault: what it is → where it lives (OneDrive found automatically, or another synced folder /
 * network drive; an existing vault there can be used) → master password and app PIN → recovery key, to be confirmed →
 * optional FIDO key. The vault is free and for one person only.
 */
export async function personalWizard() {
  const s = { step: 0, info: null, mode: 'create', id: null, recoveryKey: null };
  const body = h('div', { class: 'wizard' });
  const { dialog, close } = modal(t('Persönlicher Tresor'), body, []);
  dialog.classList.add('wizard-modal');
  // Resolves with the id of the vault that was set up here, if any.
  const closed = new Promise((resolve) => dialog.addEventListener('close', () => {
    // Closed at the key step: not confirmed, the key is dropped here and the setup stays open (see askPendingRecovery).
    if (s.recoveryKey) toast(t('Einrichtung nicht abgeschlossen: Bestätige den Wiederherstellungsschlüssel über den Hinweis in der Seitenleiste.'), 'warn');
    s.recoveryKey = null;
    resolve(s.id);
  }));
  const steps = [t('Start'), t('Speicherort'), t('Schutz'), t('Schlüssel'), t('FIDO-Stick'), t('Fertig')];
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
        // #516: "OneDrive direkt" waits for Keevault's own app registration: shown, not selectable, no network access.
        h('div', { class: 'wizard-choice personal-storage' },
          h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'pstore', checked: true }), t('Ordner auf diesem Gerät (OneDrive-Sync, anderer synchronisierter Ordner oder Netzlaufwerk)')),
          h('label', { class: 'inline muted' }, h('input', { type: 'radio', name: 'pstore', disabled: true, 'data-storage': 'onedrive-direct' }), t('OneDrive direkt (demnächst verfügbar)'))),
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
          recoveryAsked = true; // shown right here
          // The key first: a window that fails to redraw must not cost the only sight of it.
          go(3);
          reloadAll().catch((e) => toast(e.message, 'error'));
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
          go(4); // an existing vault has its recovery key already
        }, { primary: true })),
      ];
    } else if (s.step === 3) {
      const next = btn(t('Weiter'), async () => {
        await call('confirmPersonalRecovery', s.id);
        s.recoveryKey = null;
        go(4);
      }, { primary: true, disabled: true });
      content = [
        h('p', {}, t('Bewahre jetzt den Wiederherstellungsschlüssel sicher auf (ausdrucken, nicht im selben Tresor) – ohne ihn sind die Daten verloren, wenn du das Masterpasswort vergisst.')),
        ...codeConfirm(s.recoveryKey, t('Ich habe den Schlüssel sicher aufbewahrt'), (checked) => { next.disabled = !checked; }),
        notice(t('Schließt du dieses Fenster ohne Bestätigung, ist die Einrichtung nicht abgeschlossen. Keevault erinnert dich dann. Dieser Schlüssel lässt sich danach nicht mehr anzeigen, du kannst aber einen neuen erzeugen.'), 'warn'),
        buttons(next),
      ];
    } else if (s.step === 4) {
      content = [
        h('p', {}, t('Optional: Ein FIDO-Stick (z. B. YubiKey) kann den Tresor zusätzlich zum Masterpasswort entsperren – praktisch auf neuen Geräten. Der Stick muss „PRF“ (hmac-secret) unterstützen.')),
        buttons(
          btn(t('Überspringen'), () => go(5)),
          btn(t('FIDO-Stick hinzufügen …'), async () => {
            const c = st.containers.find((x) => x.id === s.id);
            if (c) await manageDialog(c, protectCtx, () => reloadAll());
          }, { primary: true }),
          btn(t('Weiter'), () => go(5))),
      ];
    } else {
      content = [
        h('p', {}, t('Der persönliche Tresor ist eingerichtet und steht ganz oben in der Seitenleiste.')),
        buttons(
          btn(t('Tresor für ein Team einrichten …'), () => { close(); vaultWizard({ intro: false }); }),
          btn(t('Fertig'), () => { close(); if (s.id) select({ view: 'container', containerId: s.id }); }, { primary: true })),
      ];
    }
    body.replaceChildren(header(), ...[content].flat().filter(Boolean));
  };
  draw();
  return closed;
}

// Smoke runs show no wizards by themselves; the checks of the first start (desktop/smoke-first-start.js) switch them on.
// Their demo has vaults already, so for them "nothing set up" counts as given. Without st.smoke these flags do nothing.
const smokeWizards = () => !!st.smoke && window.kvSmokeWizards === true;
const wizardsAllowed = () => !st.smoke || smokeWizards();

/** Nothing set up on this device and the wizards not offered yet. The settings may be stale: offerFirstStart decides. */
export function firstStartDue() {
  return wizardsAllowed() && (smokeWizards() || (st.demo ? st.platform !== 'web' : !st.containers.length)) && !st.settings.setupOffered && !document.querySelector('dialog[open]');
}

/**
 * The window draws twice at the first start (after unlocking and on the "changed" event), both times before the first
 * has saved setupOffered: only the main process may decide, or a second wizard waits below the first (#399).
 */
export async function offerFirstStart() {
  if (await call('claimFirstStart').catch(() => false)) setTimeout(() => firstStartWizards({ always: st.demo || smokeWizards() }), 400);
}

async function firstStartWizards({ always = false } = {}) {
  // #515: the Microsoft sign-in first, then the App PIN (skippable), then the rest.
  if (accountStepsDue()) {
    await accountWizard();
    setSt(await fetchState());
    // Locking closes the wizard: nothing follows on the lock screen.
    if (!st.opened) return render();
  }
  // #478: settings of another device in OneDrive come first – they may bring the vaults along.
  if (await firstStartSettings()) setSt(await fetchState());
  if (!st.opened) return render();
  const set = await personalWizard();
  await call('syncSettings').catch(() => null);
  setSt(await fetchState());
  // Locking closes the wizard: nothing follows on the lock screen.
  if (!st.opened || document.querySelector('dialog[open]')) return render();
  // A personal vault was set up: its last step offers the team vault, nothing starts by itself (#399).
  if (set) return render();
  if (!always && (st.containers.some((c) => c.kind === 'keyvault') || st.settings.containers.length)) return render();
  await vaultWizard();
  return render();
}

/** The open personal vault whose recovery key was not confirmed yet, if any. */
export function pendingRecoveryVault() {
  const pending = st?.recoveryPending || [];
  return st?.containers?.find((c) => c.personal && !c.locked && pending.includes(c.id)) || null;
}

/** Asks for the new master password the key change needs (#402): → the password, or null when cancelled. */
function askNewMasterPassword() {
  return new Promise((resolve) => {
    const pw1 = h('input', { type: 'password', autocomplete: 'new-password', 'data-rekey': 'password' });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password', 'data-rekey': 'repeat' });
    const { dialog } = modal(t('Neues Masterpasswort'), h('div', {},
      h('div', { class: 'field' }, h('label', {}, t('Neues Masterpasswort')), pw1, strengthMeter(pw1)),
      h('div', { class: 'field' }, h('label', {}, t('Wiederholen')), pw2)), [
      { label: t('Abbrechen'), onClick: () => resolve(null) },
      { label: t('Schlüssel wechseln'), primary: true, onClick: () => {
        if (pw1.value !== pw2.value) throw new Error(t('Die Passwörter stimmen nicht überein'));
        resolve(pw1.value);
      } },
    ]);
    dialog.addEventListener('close', () => resolve(null));
  });
}

/**
 * Only asks. The key may be saved and just not confirmed, and it can't be shown again because it isn't kept: a new one
 * comes only from the click on that button, and the old one then stops working in the app (#399).
 */
export async function askPendingRecovery(c) {
  if (recoveryBusy) return;
  recoveryBusy = true;
  recoveryAsked = true;
  try {
    // A renewed key was on screen once and not confirmed then: nobody can say it was saved, so only a new one helps.
    const renewed = (st?.recoveryRenewed || []).includes(c.id);
    const choice = await new Promise((resolve) => {
      const { dialog } = modal(t('Wiederherstellungsschlüssel'), h('div', {},
        h('p', {}, renewed
          ? t('Die Einrichtung deines persönlichen Tresors ist noch nicht abgeschlossen: Der zuletzt erzeugte Wiederherstellungsschlüssel wurde nicht bestätigt. Erzeuge einen neuen und bewahre ihn sicher auf.')
          : t('Die Einrichtung deines persönlichen Tresors ist noch nicht abgeschlossen: Der Wiederherstellungsschlüssel ist nicht bestätigt. Hast du ihn sicher aufbewahrt, bestätige das. Sonst erzeuge einen neuen.')),
        h('p', { class: 'muted small' }, KEY_CHANGE.enabled ? t('Der Tresor bekommt dabei einen neuen Schlüssel und ein neues Masterpasswort. Der alte Wiederherstellungsschlüssel und das alte Masterpasswort öffnen ihn danach auch zusammen mit einer älteren Dateiversion nicht mehr. Auf anderen Geräten muss er danach neu entsperrt werden.') : t('In der App gilt der alte Schlüssel dann nicht mehr. Mit einer älteren Dateiversion kann er aber weiter wirken, bewahre frühere Schlüssel also sicher auf oder vernichte sie.'))), [
        { label: t('Später'), onClick: () => resolve('later') },
        ...(renewed ? [] : [{ label: t('Ich habe den Schlüssel sicher aufbewahrt'), onClick: () => resolve('kept') }]),
        { label: t('Neuen Schlüssel erzeugen'), primary: true, onClick: () => resolve('new') },
      ]);
      dialog.classList.add('recovery-ask');
      dialog.addEventListener('close', () => resolve('later'));
    });
    if (choice === 'kept') await call('confirmPersonalRecovery', c.id);
    if (choice !== 'new') return;
    const password = KEY_CHANGE.enabled ? await askNewMasterPassword() : null;
    if (KEY_CHANGE.enabled && !password) return;
    const { recoveryKey } = await call('renewPersonalRecovery', c.id, password);
    // Locked in the meantime: the key stays out of sight, the mark stays and the next unlock asks again.
    if (!(await fetchState()).opened) return;
    const confirmed = await showCode(t('Wiederherstellungsschlüssel'), recoveryKey,
      t('Bewahre jetzt den Wiederherstellungsschlüssel sicher auf (ausdrucken, nicht im selben Tresor) – ohne ihn sind die Daten verloren, wenn du das Masterpasswort vergisst.'),
      t('Ich habe den Schlüssel sicher aufbewahrt'));
    if (confirmed) await call('confirmPersonalRecovery', c.id);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    recoveryBusy = false;
  }
}

/** After unlocking or a restart, when the window comes to the front: asks by itself, once. True when it asks. */
export function remindPendingRecovery() {
  const c = pendingRecoveryVault();
  // Unlocked from the browser extension with the app in the tray: nobody would see the question. Smoke windows are never
  // shown but do hold the focus, so their checks say themselves whether the window counts as in front.
  const inFront = st.smoke ? window.kvSmokeWindowShown === true : document.hasFocus();
  if (!c || recoveryAsked || !inFront || document.querySelector('dialog[open]') || !wizardsAllowed()) return false;
  askPendingRecovery(c);
  return true;
}

/** Locked: the next unlock asks again. */
export function resetRecoveryReminder() {
  recoveryAsked = false;
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
  focusField(pin);
}
