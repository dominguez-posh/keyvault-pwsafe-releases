// Updates: the dialog, release notes, the hint about a second installation.

import { h, icon, toast, modal } from '../../../extension/core/dom.js';
import { t, getLanguage, locale } from '../../../extension/core/i18n.js';
import { releaseNotesSince } from '../../../extension/core/release-notes.js';
import { call } from './ipc.js';
import { st } from './state.js';
import { notice, openUrl } from './helpers.js';

/**
 * Two installations (machine-wide MSI and per-user EXE): both are "Keevault" in the Start menu, only one updates
 * itself – people keep opening the old one. Told once per session; "Don't show again" per path and version.
 */
let otherInstallChecked = false;
export async function checkOtherInstallation(found) {
  if (otherInstallChecked && !found) return;
  otherInstallChecked = true;
  const other = found || await call('otherInstallation').catch(() => null);
  if (!other) return;
  const id = `${other.dir}|${other.version}`;
  if (!found && st.settings.otherInstallDismissed === id) return;
  const text = other.kind === 'msi'
    ? t('Auf diesem Gerät ist zusätzlich eine Keevault-Installation für alle Benutzer (Version {version}, {dir}). Sie aktualisiert sich nicht selbst und steht im Startmenü ebenfalls als „Keevault“ – so startet man leicht die alte Version.', { version: other.version || '?', dir: other.dir })
    : t('Auf diesem Gerät ist zusätzlich eine Keevault-Installation nur für dich (Version {version}, {dir}). Sie steht im Startmenü ebenfalls als „Keevault“ – so startet man leicht die falsche Version.', { version: other.version || '?', dir: other.dir });
  modal(t('Zwei Keevault-Installationen'), h('div', {},
    h('p', {}, text),
    h('p', {}, other.kind === 'msi'
      ? t('Empfehlung: Die Installation für alle Benutzer unter Einstellungen → Apps deinstallieren (braucht Administratorrechte) – oder, wenn eure IT Keevault verteilt, die Installation nur für dich entfernen.')
      : t('Empfehlung: Eine der beiden unter Einstellungen → Apps deinstallieren. Deine Tresore und Einstellungen bleiben erhalten.')),
    h('p', { class: 'muted small' }, t('Diese Version: {version}', { version: st.version || '' }))), [
    { label: t('Nicht mehr anzeigen'), onClick: () => call('updateSettings', { otherInstallDismissed: id }).then((s) => { st.settings = s; }) },
    { label: t('Später') },
    { label: t('Apps öffnen'), primary: true, onClick: () => call('openAppsSettings') },
  ]);
}

export const updateListeners = new Set();

/** Why this installation does not update itself ('' when it does): MSI/MSIX package, or policy SelfUpdate=0. */
export function managedUpdateHint(kind) {
  if (kind === 'managed') return t('Updates verteilt deine IT (Richtlinie SelfUpdate). Die App installiert nichts selbst.');
  if (kind === 'msi' || kind === 'msix') return t('Diese Installation (MSI/MSIX) wird von deiner IT bzw. über das Windows-Paket aktualisiert.');
  return '';
}

/** Release notes from the signed manifest (CHANGELOG section) as a list; "- " lines are items, others plain text. */
function releaseNotes(notes, installed) {
  const versions = releaseNotesSince(notes, installed, getLanguage());
  if (!versions.length) return null;
  // "Area: text" → the area in bold, as in the changelog ("Browser-Erweiterung: …").
  const item = (text) => {
    const m = /^([^:]{2,40}):\s+(.+)$/.exec(text);
    return h('li', {}, m ? [h('b', {}, `${m[1]}: `), m[2]] : text);
  };
  return h('div', { class: 'release-notes' },
    h('h4', {}, versions.length > 1 ? t('Neu seit deiner Version ({count} Updates)', { count: versions.length }) : t('Neu in dieser Version')),
    h('div', { class: 'rn-scroll' }, ...versions.map((v) => h('section', { class: 'rn-version' },
      v.version ? h('div', { class: 'rn-head' }, h('span', { class: 'rn-badge' }, v.version),
        v.date ? h('span', { class: 'muted small' }, /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? new Date(`${v.date}T12:00:00`).toLocaleDateString(locale()) : v.date) : null) : null,
      h('ul', {}, ...v.items.map(item))))));
}

/** Update error of the app (search, download, signature check): its code (KV-U…) and its section in the knowledge base. */
function updateErrorView(message) {
  const code = /signatur|signiert|signature/i.test(message) ? 'KV-U2'
    : /HTTP|net::|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|timeout|offline|proxy/i.test(message) ? 'KV-U1' : 'KV-U3';
  const url = `${getLanguage() === 'en' ? 'https://keevault.de/en/knowledge/install-and-update.html' : 'https://keevault.de/wissen/installation-und-updates.html'}#${code.toLowerCase()}`;
  return h('div', {}, notice(t('Update fehlgeschlagen: {message}', { message })),
    h('p', { class: 'muted small' }, t('Fehlercode {code}', { code }), ' · ',
      h('button', { type: 'button', class: 'linklike', onclick: () => openUrl(url) }, t('Hilfe zu diesem Fehler'))));
}

/**
 * "Check for updates" (version label, settings, tray): result, download progress, install. With `offered` (new
 * version found at start, mode "ask") the dialog shows that result right away – "Later" closes it.
 */
export async function updateDialog(offered) {
  const body = h('div', {});
  const { close } = modal(offered ? t('Update verfügbar') : t('Updates'), body, [{ label: offered ? t('Später') : t('Schließen') }]);
  const draw = (s) => {
    if (!s) return;
    const managed = !!managedUpdateHint(s.kind);
    if (s.status === 'checking') return body.replaceChildren(h('p', {}, h('span', { class: 'spinner' }), ' ', t('Suche nach Updates …')));
    if (s.status === 'error') return body.replaceChildren(updateErrorView(s.error));
    if (s.status === 'downloading') {
      return body.replaceChildren(h('p', {}, t('Version {version} wird heruntergeladen …', { version: s.version || '' })),
        h('progress', { class: 'update-progress', max: 100, value: s.progress || 0 }));
    }
    if (s.status === 'none') return body.replaceChildren(h('p', {}, t('Keevault {version} ist aktuell.', { version: s.current })));
    if (s.status === 'available' || s.status === 'ready') {
      const notes = releaseNotes(s.notes, s.current);
      return body.replaceChildren(
        h('p', {}, t('Version {version} ist verfügbar (installiert: {current}).', { version: s.version, current: s.current })),
        ...(notes ? [notes] : []),
        managed
          ? h('p', { class: 'muted small' }, managedUpdateHint(s.kind))
          : h('p', { class: 'muted small' }, t('Keevault lädt das Update von keevault.de, installiert es und startet neu. Deine Daten bleiben unverändert.')),
        managed
          ? h('button', { type: 'button', class: 'btn', onclick: () => openUrl('https://keevault.de/download.html') }, icon('external', 14), t('Download-Seite öffnen'))
          : h('button', { type: 'button', class: 'btn primary', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await call('installUpdate');
            } catch (err) {
              toast(err.message, 'error');
            }
          } }, icon('download', 14), s.status === 'ready' ? t('Jetzt installieren und neu starten') : t('Jetzt aktualisieren')));
    }
    return undefined;
  };
  updateListeners.add(draw);
  body.closest('dialog')?.addEventListener('close', () => updateListeners.delete(draw));
  // No secret in it, and it follows a running download.
  if (body.closest('dialog')) body.closest('dialog').dataset.keepOnLock = '1';
  if (offered) {
    draw(offered);
    return close;
  }
  draw({ status: 'checking' });
  try {
    draw(await call('checkForUpdates'));
  } catch (e) {
    draw({ status: 'error', error: e.message });
  }
  return close;
}
