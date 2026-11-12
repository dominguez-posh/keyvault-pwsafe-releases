// #494: "Browser-Erweiterung neu installieren" in the settings and in the hint on the extension. One click is the consent:
// UAC follows at once (main process, desktop/main/extension-reinstall.js), no dialog of our own before it. Afterwards one
// question per browser, "Edge komplett neu starten?", then the restart and the check that the extension is connected again.

import { h, modal } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';

const NAMES = { edge: 'Edge', chrome: 'Chrome' };
let running = false;

/** "Edge komplett neu starten?" – resolves true for "Neu starten", false for "Später" or closing. */
export function askRestart(browser) {
  const name = NAMES[browser];
  return new Promise((resolve) => {
    let answered = false;
    const answer = (v) => { answered = true; resolve(v); };
    const { dialog } = modal(t('{browser} komplett neu starten?', { browser: name }), h('div', {},
      h('p', {}, t('Damit {browser} die neue Einrichtung übernimmt, beendet Keevault den Browser vollständig, auch im Hintergrund, und öffnet ihn mit den zuletzt offenen Tabs wieder.', { browser: name })),
      h('p', { class: 'muted small' }, t('Ungespeicherte Eingaben in {browser} können dabei verloren gehen.', { browser: name }))), [
      { label: t('Später'), onClick: () => answer(false) },
      { label: t('Neu starten'), primary: true, onClick: () => answer(true) },
    ]);
    dialog.id = 'ext-restart-ask';
    dialog.dataset.browser = browser;
    dialog.addEventListener('close', () => { if (!answered) resolve(false); });
  });
}

/** The notice after the elevated step, when nothing is restarted (or it was declined). */
function setupResult(r) {
  if (r.result === 'declined') return { kind: 'error', text: t('Abgebrochen: Die Administratorabfrage wurde nicht bestätigt. Es wurde nichts geändert.') };
  if (r.result === 'company') return { kind: 'error', text: t('Nicht geändert: Die Richtlinie legt deine Firma fest – wende dich an deine IT.') };
  if (r.result === 'meanwhile') return { kind: 'error', text: t('Nicht übernommen: Die Richtlinie wurde inzwischen geändert. Keevault hat sie nicht überschrieben.') };
  if (r.result === 'failed') return { kind: 'error', text: t('Neu installieren fehlgeschlagen: Die Einrichtung wurde nicht vollständig geschrieben.') };
  return { kind: 'error', text: t('Auf diesem Gerät kann Keevault die Einrichtung nicht selbst vornehmen.') };
}

/** The notice after the restart: connected with the version, or what went wrong. */
export function restartResult(c, nativeHost) {
  const off = nativeHost === 'off' ? ` ${t('Hinweis: Der Browser-Zugang zu Datei-Tresoren ist in den Einstellungen ausgeschaltet.')}` : '';
  if (c.failed?.length && !c.restarted?.length) {
    return { kind: 'error', text: t('{browser} konnte nicht neu gestartet werden. Bitte den Browser selbst schließen und wieder öffnen.', { browser: c.failed.map((f) => NAMES[f.browser]).join(', ') }) };
  }
  if (!c.connected) return { kind: 'error', text: `${t('Die Erweiterung hat sich nach dem Neustart noch nicht gemeldet. Bitte in einer Minute „Erneut prüfen“ wählen; hilft das nicht, den PC neu starten.')}${off}` };
  if (c.state === 'ok' && c.extVersion === c.expected) return { kind: 'ok', text: `${t('Erweiterung ist wieder verbunden ({version}).', { version: c.extVersion })}${off}` };
  if (c.state === 'ok') return { kind: 'ok', text: t('Erweiterung ist wieder verbunden ({version}), erwartet ist {expected}. Der Browser lädt das Update meist in den nächsten Minuten.', { version: c.extVersion || t('unbekannt'), expected: c.expected }) };
  return { kind: 'error', text: t('Die Erweiterung ist verbunden, passt aber noch nicht zur App (gefunden: {version}, App: {expected}).', { version: c.extVersion || t('unbekannt'), expected: c.expected }) };
}

/**
 * The whole flow. report(result) shows a notice ({ kind: 'ok' | 'error' | 'progress', text }); it is called for the
 * progress while the restart runs and once with the end result. Resolves that end result.
 */
export async function reinstallBrowserExtension(report) {
  if (running) return null;
  running = true;
  try {
    let r;
    try {
      r = await call('extensionReinstall');
    } catch (e) {
      const out = { kind: 'error', text: t('Neu installieren fehlgeschlagen: {error}', { error: e.message }) };
      report(out);
      return out;
    }
    if (r.result !== 'changed') {
      const out = setupResult(r);
      report(out);
      return out;
    }
    const chosen = [];
    for (const b of r.browsers) if (await askRestart(b)) chosen.push(b);
    if (!chosen.length) {
      await call('extensionRestartBrowsers', []).catch(() => {});
      const out = { kind: 'ok', text: t('Neu eingerichtet. Bitte den Browser später vollständig neu starten, damit er die Erweiterung neu lädt.') };
      report(out);
      return out;
    }
    report({ kind: 'progress', text: t('Browser wird neu gestartet, Verbindung zur Erweiterung wird geprüft …') });
    let out;
    try {
      out = restartResult(await call('extensionRestartBrowsers', chosen), r.nativeHost);
    } catch (e) {
      out = { kind: 'error', text: t('Neu installieren fehlgeschlagen: {error}', { error: e.message }) };
    }
    report(out);
    return out;
  } finally {
    running = false;
  }
}

/** The part in Settings → Integrationen → Browser-Erweiterung (Windows only): the button, or the hint that the IT manages it. */
export function reinstallSettingsPart() {
  const box = h('div', { id: 'ext-reinstall-settings' });
  const out = h('p', { class: 'muted small', id: 'ext-reinstall-result', role: 'status' });
  call('extensionReinstallState').then((x) => {
    if (!x?.available) {
      box.replaceChildren(...(x?.company ? [h('p', { class: 'muted small' }, t('Die Browser-Erweiterung verteilt auf diesem Gerät deine IT über eigene Richtlinien. Keevault legt deshalb keine Richtlinie an – wende dich an deine IT.'))] : []));
      return;
    }
    const button = h('button', { type: 'button', class: 'btn small', id: 'ext-reinstall-btn', onclick: async () => {
      button.disabled = true;
      try {
        await reinstallBrowserExtension((r) => { out.dataset.kind = r.kind; out.textContent = r.text; });
      } finally {
        button.disabled = false;
      }
    } }, t('Browser-Erweiterung neu installieren'));
    box.replaceChildren(h('div', { class: 'actions' }, button),
      h('p', { class: 'muted small' }, t('Richtet die Erweiterung in Edge und Chrome neu ein und startet den Browser auf Wunsch neu. Windows fragt dafür nach Administratorrechten.')), out);
  }, () => {});
  return box;
}
