// Encrypted backup and restore of a Key Vault vault.

import { h, icon, setChildren, toast, modal, formatDateTime } from '../../../extension/core/dom.js';
import { t } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { progressListeners } from './state.js';
import { field, notice } from './helpers.js';
import { reloadAll } from './shell.js';
import { licenses } from './vault-dialogs.js';

export function progressLine() {
  const el = h('div', { class: 'muted small' });
  const listener = (ev) => { el.textContent = t('{done} von {total}', { done: ev.done, total: ev.total }); };
  progressListeners.add(listener);
  return { el, stop: () => progressListeners.delete(listener) };
}

function ownerCheck(c, slot, onOk) {
  setChildren(slot, h('div', { class: 'muted small' }, t('Berechtigung wird geprüft …')));
  call('backupAllowed', c.id).then((r) => {
    if (r.allowed) {
      setChildren(slot, notice(t('Du bist Besitzer (Owner) der Subscription.'), 'info'));
      onOk();
    } else setChildren(slot, notice(r.reason));
  }, (e) => setChildren(slot, notice(e.message)));
}

export function backupDialog(c) {
  const slot = h('div');
  let allowed = false;
  const body = h('div', {},
    h('p', {}, t('Erstellt eine verschlüsselte Sicherung aller Einträge von „{name}“ als Datei. Geschützt wird sie mit einem Passwort, das die App erzeugt und nur ein einziges Mal anzeigt.', { name: c.name })),
    notice(t('Wer Backup-Datei und Passwort hat, kann alle Passwörter dieses Tresors lesen. Für die sichere Aufbewahrung von Datei und Passwort bist du als Kunde selbst verantwortlich.'), 'warn'),
    slot);
  const progress = progressLine();
  const { dialog } = modal(t('Backup erstellen'), body, [
    { label: t('Abbrechen') },
    { label: t('Speicherort wählen und Backup erstellen'), primary: true, onClick: async () => {
      if (!allowed) throw new Error(t('Backup und Wiederherstellung sind nur für Besitzer (Owner) der Subscription möglich.'));
      body.append(progress.el);
      const r = await call('createBackup', c.id);
      if (!r) return false;
      backupPasswordDialog(r);
      return true;
    } },
  ]);
  dialog.addEventListener('close', progress.stop);
  ownerCheck(c, slot, () => { allowed = true; });
}

function backupPasswordDialog(r) {
  const confirmed = h('input', { type: 'checkbox' });
  const { dialog } = modal(t('Backup-Passwort – nur jetzt sichtbar'), h('div', {},
    notice(t('Backup gespeichert: {file} ({count} Secrets).', { file: r.file, count: r.count }), 'info'),
    h('p', {}, t('Ohne dieses Passwort lässt sich das Backup nicht wiederherstellen. Es wird nur jetzt angezeigt und nirgends gespeichert – auch nicht beim Hersteller.')),
    h('div', { class: 'backup-password' }, r.password),
    h('div', { class: 'danger-box' },
      h('h3', {}, t('Jetzt ausdrucken und sicher ablegen')),
      h('ul', {},
        h('li', {}, t('Drucke das Passwortblatt aus und lege es in einen Tresor oder ein Bankschließfach.')),
        h('li', {}, t('Bewahre Blatt und Backup-Datei getrennt voneinander auf.')),
        h('li', {}, t('Speichere das Passwort nicht unverschlüsselt am PC und nicht im selben Tresor.')),
        h('li', {}, t('Für die sichere Aufbewahrung von Backup-Datei und Passwort ist der Kunde selbst verantwortlich.')))),
    h('label', { class: 'inline' }, confirmed, t('Ich habe das Passwort ausgedruckt bzw. notiert und sicher abgelegt.'))), [
    { label: t('Passwortblatt drucken'), onClick: async () => {
      await call('printBackupSheet');
      return false;
    } },
    { label: t('Fertig'), primary: true, onClick: async () => {
      if (!confirmed.checked) throw new Error(t('Bitte bestätigen, dass das Passwort sicher abgelegt ist'));
      return true;
    } },
  ]);
  dialog.addEventListener('close', () => call('forgetBackupPassword').catch(() => {}));
}

export function restoreDialog(c) {
  const slot = h('div');
  const fileInfo = h('div');
  const password = h('input', { class: 'mono', autocomplete: 'off', spellcheck: 'false', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX' });
  const confirmed = h('input', { type: 'checkbox' });
  let header = null;
  let allowed = false;
  const choose = h('button', { class: 'btn', type: 'button', disabled: true, onclick: async () => {
    try {
      header = await call('chooseBackupFile', c.id);
      if (!header) return;
      const other = header.vault !== c.id;
      setChildren(fileInfo, h('div', { class: 'notice info' },
        h('div', {}, h('b', {}, header.file)),
        h('div', { class: 'small' }, t('Tresor: {vault} · erstellt {date} von {by} · {count} Secrets', { vault: header.vault, date: formatDateTime(header.created), by: header.createdBy || '?', count: header.count }))),
      other ? notice(header.protected
        ? t('Dieses Backup stammt aus einem anderen, zusätzlich verschlüsselten Tresor und lässt sich nur dort zurückspielen.')
        : t('Das Backup stammt aus einem anderen Tresor ({vault}). Die Einträge werden in „{name}“ kopiert; Lizenz und Kennung von „{name}“ bleiben erhalten.', { vault: header.vault, name: c.name }), 'warn') : null);
      password.focus();
    } catch (e) {
      toast(e.message, 'error');
    }
  } }, icon('upload', 14), t('Backup-Datei wählen …'));
  const progress = progressLine();
  const body = h('div', {},
    h('p', {}, t('Spielt ein Backup in „{name}“ zurück: fehlende und gelöschte Einträge kommen wieder, geänderte erhalten den Stand des Backups (der aktuelle Stand bleibt im Verlauf). Einträge, die nicht im Backup sind, bleiben unverändert.', { name: c.name })),
    slot, choose, fileInfo,
    field(t('Backup-Passwort'), password, t('Steht auf dem ausgedruckten Passwortblatt.')),
    h('label', { class: 'inline' }, confirmed, t('Ich möchte den Stand des Backups in diesen Tresor schreiben.')));
  const { dialog } = modal(t('Backup wiederherstellen'), body, [
    { label: t('Abbrechen') },
    { label: t('Wiederherstellen'), primary: true, onClick: async () => {
      if (!allowed) throw new Error(t('Backup und Wiederherstellung sind nur für Besitzer (Owner) der Subscription möglich.'));
      if (!header) throw new Error(t('Bitte zuerst die Backup-Datei wählen'));
      if (!password.value.trim()) throw new Error(t('Bitte das Backup-Passwort eingeben'));
      if (!confirmed.checked) throw new Error(t('Bitte die Wiederherstellung bestätigen'));
      body.append(progress.el);
      const r = await call('restoreBackup', c.id, password.value);
      licenses.delete(c.id);
      await reloadAll();
      modal(t('Wiederherstellung abgeschlossen'), h('div', {},
        h('p', {}, t('{restored} wiederhergestellt (davon {recovered} aus dem Papierkorb), {unchanged} unverändert.', r)),
        r.failed.length ? notice(t('Fehlgeschlagen: {list}', { list: r.failed.map((f) => `${f.name} (${f.error})`).join(', ') })) : null));
      return true;
    } },
  ]);
  dialog.addEventListener('close', progress.stop);
  ownerCheck(c, slot, () => { allowed = true; choose.disabled = false; });
}
