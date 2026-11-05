// The settings dialog.

import { h, icon, toast, modal } from '../../../extension/core/dom.js';
import { t, LANGUAGES } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { explicitFolders, items, st } from './state.js';
import { copy, field, tabbed } from './helpers.js';
import { pinDialog } from './admin-mode.js';
import { mcpScopes, mcpShared, setMcpScopes } from './agents.js';
import { viewSettings } from './main-menu.js';
import { ASSET_FOLDERS } from './modes.js';
import { reloadAll, render } from './shell.js';
import { managedUpdateHint, updateDialog } from './updates.js';

export function settingsDialog() {
  const s = st.settings;
  const enforced = (k) => s.enforced.includes(k);
  const language = h('select', { disabled: enforced('language') },
    ...Object.entries(LANGUAGES).map(([k, label]) => h('option', { value: k, selected: s.language === k }, k === 'auto' ? t(label) : label)));
  const tenant = h('input', { value: s.tenantId, disabled: enforced('tenantId'), placeholder: t('automatisch') });
  const client = h('input', { value: s.clientId, disabled: enforced('clientId'), placeholder: t('automatisch') });
  const directory = h('select', { disabled: enforced('tenantId') || !st.signedIn, onchange: async () => {
    directory.disabled = true;
    try {
      const r = await call('switchTenant', directory.value);
      if (r.discoverError) toast(t('Tresor-Suche: {message}', { message: r.discoverError }), 'error');
      tenant.value = directory.value;
      s.tenantId = directory.value;
      toast(t('Verzeichnis gewechselt'));
      await reloadAll();
    } catch (e) {
      toast(e.message, 'error');
    }
    directory.disabled = false;
  } }, h('option', { value: '' }, t('Standardverzeichnis meines Kontos')));
  if (st.signedIn) {
    call('tenants').then((list) => {
      for (const x of list) directory.append(h('option', { value: x.tenantId, selected: x.tenantId === s.tenantId }, x.domain ? x.name + ' (' + x.domain + ')' : x.name));
    }, () => {});
  }
  const autoLock = h('input', { type: 'number', min: 0, max: 1440, value: s.autoLockMinutes, disabled: enforced('autoLockMinutes') });
  const clip = h('input', { type: 'number', min: 0, max: 600, value: s.clipboardSeconds, disabled: enforced('clipboardSeconds') });
  const prompt = h('select', { disabled: enforced('unlockPrompt') },
    ...[['none', 'Ohne Rückfrage, wenn möglich (SSO, Standard)'], ['select_account', 'Konto bestätigen'], ['login', 'Immer neu anmelden (Passwort/MFA)']]
      .map(([v, l]) => h('option', { value: v, selected: s.unlockPrompt === v }, t(l))));
  const browser = h('input', { type: 'checkbox', checked: s.browserIntegration, disabled: enforced('browserIntegration') });
  const windowsProvider = h('input', { type: 'checkbox', checked: s.windowsProvider, disabled: enforced('windowsProvider') });
  const windowsStatus = h('div', { class: 'muted small' }, h('span', { class: 'spinner' }));
  call('windowsProviderStatus').then((w) => windowsStatus.replaceChildren(!w.supported ? t('Nur unter Windows 11 verfügbar.')
    : !w.installed ? t('Nicht installiert – windows/Install-PasskeyProvider.ps1 ausführen (siehe README).')
      : w.enabled ? t('Installiert und in Windows aktiviert.')
        : w.registered ? t('Installiert, aber in Windows noch nicht aktiviert (Einstellungen → Konten → Passkeys → Erweiterte Optionen).')
          : t('Installiert, aber noch nicht bei Windows registriert.')), () => windowsStatus.replaceChildren());
  const extensionIds = h('input', { value: s.extensionIds.join(', '), disabled: enforced('extensionIds') });
  const signInWindows = h('input', { type: 'checkbox', checked: s.signInWindows !== false, disabled: enforced('signInWindows') });
  const startWithWindows = h('input', { type: 'checkbox', checked: !!s.startWithWindows });
  const autoDiscover = h('input', { type: 'checkbox', checked: !!s.autoDiscover });
  const settingsSync = h('input', { type: 'checkbox', checked: s.settingsSync !== false });
  const autoTypeKeys = h('select', {},
    ...[['CommandOrControl+Shift', 'Strg+Umschalt+U / P / O'], ['CommandOrControl+Alt', 'Strg+Alt+U / P / O'], ['', 'Aus (nur im App-Fenster)']]
      .map(([v, l]) => h('option', { value: v, selected: s.autoTypeKeys === v }, t(l))));
  const mcpEnabled = h('input', { type: 'checkbox', checked: !!s.mcpEnabled, disabled: enforced('mcpEnabled') });
  const mcpPasskeys = h('input', { type: 'checkbox', name: 'mcpPasskeys', checked: !!s.mcpPasskeys });
  const mcpMicrosoft = h('input', { type: 'checkbox', name: 'mcpMicrosoft', checked: !!s.mcpMicrosoft });
  const offlineMirror = h('input', { type: 'checkbox', checked: !!s.offlineMirror && st.pinSet, disabled: enforced('offlineMirror') || !st.pinSet });
  const mcpBox = h('div', {});
  const mcpMode = h('select', { disabled: enforced('mcpScope') },
    h('option', { value: 'selected', selected: s.mcpScope !== 'all' }, t('Nur freigegebene Tresore und Ordner (empfohlen)')),
    h('option', { value: 'all', selected: s.mcpScope === 'all' }, t('Alle Tresore, auf die ich Zugriff habe')));
  const scopeList = h('div', {});
  const vaultName = (id) => st.containers.find((c) => c.id === id)?.name || id;
  const drawScopes = () => scopeList.replaceChildren(...(mcpScopes().length ? mcpScopes().map((x) => h('div', { class: 'inline' },
    icon(x.folder ? 'folder' : 'vault', 14), h('span', {}, x.folder ? `${vaultName(x.vaultId)} / ${x.folder}` : t('{vault} (ganzer Tresor)', { vault: vaultName(x.vaultId) })),
    h('button', { type: 'button', class: 'btn small', onclick: async () => {
      await setMcpScopes(mcpScopes().filter((y) => !(y.vaultId === x.vaultId && (y.folder || '') === (x.folder || ''))));
      drawScopes();
    } }, t('Entfernen')))) : [h('p', { class: 'muted small' }, t('Noch nichts freigegeben – Agenten sehen keine Einträge.'))]));
  const scopeVault = h('select', {}, ...st.containers.filter((c) => !c.error).map((c) => h('option', { value: c.id }, c.name)));
  const scopeFolder = h('select', {});
  const fillFolders = async () => {
    const id = scopeVault.value;
    const paths = new Set([...items.filter((i) => i.containerId === id).map((i) => i.folder), ...(explicitFolders.get(id) || await call('folders', id).catch(() => []))].filter((p) => p && !p.startsWith(ASSET_FOLDERS)));
    for (const p of [...paths]) p.split('/').forEach((_, n, parts) => paths.add(parts.slice(0, n + 1).join('/')));
    scopeFolder.replaceChildren(h('option', { value: '' }, t('Ganzer Tresor')), ...[...paths].sort().map((p) => h('option', { value: p }, p)));
  };
  scopeVault.addEventListener('change', fillFolders);
  if (s.mcpEnabled) {
    fillFolders();
    drawScopes();
  }
  const scopeAdd = h('button', { type: 'button', class: 'btn small', onclick: async () => {
    if (!scopeVault.value) return;
    if (!mcpShared(scopeVault.value, scopeFolder.value)) await setMcpScopes([...mcpScopes(), { vaultId: scopeVault.value, folder: scopeFolder.value }]);
    drawScopes();
  } }, icon('plus', 14), t('Freigeben'));
  if (s.mcpEnabled) {
    call('mcpInfo').then((info) => {
      const snippet = (label, text) => h('div', { class: 'field' }, h('label', {}, label),
        h('pre', { class: 'snippet' }, text),
        h('button', { type: 'button', class: 'btn small', onclick: () => copy(text, t('Konfiguration')) }, icon('copy', 14), t('Kopieren')));
      mcpBox.replaceChildren(
        h('p', { class: 'muted small' }, t('In den KI-Client eintragen – danach den Client neu starten. Beim ersten Zugriff fragt Keevault, ob du den Agenten erlaubst.')),
        snippet(t('Claude Desktop (claude_desktop_config.json)'), info.claudeDesktop),
        snippet(t('Claude Code (Befehl im Terminal)'), info.claudeCode),
        snippet(t('VS Code / GitHub Copilot (.vscode/mcp.json oder Benutzer-mcp.json)'), info.vscode),
        snippet(t('Andere MCP-Clients (stdio)'), `command: ${info.command}\nargs: ${info.args.join(' ')}\nenv: ELECTRON_RUN_AS_NODE=1`),
        h('div', { class: 'field' }, h('label', {}, t('Erlaubte Agenten')),
          info.agents.length ? h('div', {}, ...info.agents.map((a) => {
            const session = info.sessions.find((x) => x.agent === a);
            const rule = info.rules?.[a] || { write: true, until: null };
            const writeSel = h('select', { onchange: async () => { await call('mcpAgentRule', a, { write: writeSel.value === 'rw' }); toast(t('Gespeichert')); } },
              h('option', { value: 'rw', selected: rule.write !== false }, t('Lesen und Schreiben')), h('option', { value: 'ro', selected: rule.write === false }, t('Nur lesen')));
            const untilSel = h('select', { onchange: async () => { await call('mcpAgentRule', a, { days: Number(untilSel.value) }); toast(t('Gespeichert')); } },
              h('option', { value: '0', selected: !rule.until }, t('unbegrenzt')), ...[1, 7, 30, 90].map((d) => h('option', { value: String(d) }, t('{n} Tage', { n: d }))));
            return h('div', { class: 'inline' }, h('span', {}, a), writeSel, untilSel,
              rule.until ? h('span', { class: 'badge' }, t('bis {date}', { date: new Date(rule.until).toLocaleDateString() })) : null,
              session ? h('span', { class: 'badge accent' }, t('Passwörter freigegeben bis {time}', { time: new Date(session.until).toLocaleTimeString() })) : null,
              h('button', { type: 'button', class: 'btn small', onclick: async (e) => {
                await call('mcpRemoveAgent', a);
                e.currentTarget.closest('.inline').remove();
                toast(t('Entfernt'));
              } }, t('Entfernen')));
          })) : h('p', { class: 'muted small' }, t('Noch kein Agent verbunden.'))),
      );
    }, () => {});
  }
  const updateMode = h('select', { disabled: enforced('updateMode') },
    ...[['ask', 'Beim Start prüfen und Update anbieten (Standard)'], ['auto', 'Automatisch aktuell halten'], ['off', 'Aus – nur manuell suchen']]
      .map(([v, l]) => h('option', { value: v, selected: (s.updateMode || 'ask') === v }, t(l))));
  // Early Access: versions in the field test before everyone gets them (beta feed on keevault.de).
  const updateChannel = h('select', { name: 'updateChannel', disabled: enforced('updateChannel') },
    ...[['stable', 'Stabil – nur freigegebene Versionen (Standard)'], ['beta', 'Early Access – neue Versionen schon im Praxistest']]
      .map(([v, l]) => h('option', { value: v, selected: (s.updateChannel || 'stable') === v }, t(l))));
  const machine = h('div', { class: 'muted small' });
  const drawMachine = (x) => {
    if (!x?.supported) return machine.replaceChildren();
    const yes = (v) => (v ? t('ja') : t('nein'));
    const button = h('button', { type: 'button', class: 'btn small', onclick: async () => {
      button.disabled = true;
      try {
        drawMachine((await call('runMachineSetup')).machine);
        toast(t('Gerät eingerichtet – Edge/Chrome ggf. neu starten'));
      } catch (e) {
        toast(e.message, 'error');
        button.disabled = false;
      }
    } }, t('Mit Administratorrechten einrichten'));
    // h() skips null children, replaceChildren() would print "null".
    return machine.replaceChildren(h('div', {},
      h('div', {}, t('Zertifikat des Passkey-Anbieters vertraut: {v}', { v: yes(x.certTrusted) })),
      h('div', {}, t('Erweiterungs-Richtlinie Edge: {edge} · Chrome: {chrome}', { edge: yes(x.edgePolicy), chrome: yes(x.chromePolicy) })),
      (!x.certTrusted || !x.edgePolicy) && x.canRunSetup ? button : null));
  };
  call('machineSetupStatus').then(drawMachine, () => {});
  const section = (title, ...children) => h('div', { class: 'settings-section' }, h('h3', {}, title), ...children);
  const managed = !!managedUpdateHint(st.updateKind);
  // Five tabs instead of one long page: everyday settings first, integrations and agents further right.
  // Fixed size, navigation on the left (#211): the dialog no longer jumps between tabs, only the page scrolls.
  const { dialog: settingsDialogEl } = modal(t('Einstellungen'), tabbed('settings', [
    { label: t('Allgemein'), icon: 'settings', content: [
      field(t('Sprache'), language),
      st.platform === 'win32' ? h('label', { class: 'inline' }, startWithWindows, t('Mit Windows starten (im Infobereich)')) : null,
      st.platform === 'win32' ? h('p', { class: 'muted small' }, t('Dann ist Keevault für Browser-Erweiterung und KI-Agenten sofort da, ohne dass sie die App erst starten müssen.')) : null,
      section(t('Einstellungen mitnehmen'),
        h('label', { class: 'inline' }, settingsSync, t('Einstellungen im persönlichen Tresor speichern')),
        h('p', { class: 'muted small' }, (st.settings.personalVaults || []).length
          ? t('Verbundene Tresore, Ansicht und Verhalten liegen verschlüsselt im persönlichen Tresor. Auf einem neuen Gerät übernimmt Keevault sie, sobald du dort den persönlichen Tresor öffnest. PIN, Geräteschlüssel und Freigaben für KI-Agenten bleiben auf dem Gerät.')
          : t('Dafür zuerst einen persönlichen Tresor einrichten.'))),
      section(t('Updates'),
        managed
          ? h('p', { class: 'muted small' }, managedUpdateHint(st.updateKind))
          : [field(t('Automatische Updates'), updateMode, t('„Automatisch“ installiert neue Versionen, sobald die App gesperrt ist oder beendet wird. Die Updates kommen von keevault.de.')),
            field(t('Update-Kanal'), updateChannel, t('Early Access bekommt neue Versionen, bevor sie für alle freigegeben werden – hilf beim Testen. Zurück auf „Stabil“ bleibt die installierte Version, bis die stabile sie eingeholt hat.'))],
        h('button', { type: 'button', class: 'btn small', onclick: () => updateDialog() }, icon('download', 14), t('Jetzt nach Updates suchen'))),
      s.enforced.length ? h('p', { class: 'muted small' }, t('Ausgegraute Werte sind über kvpwsafe.config.json vorgegeben.')) : null,
      h('p', { class: 'muted small' }, t('Version {version}', { version: st.version })),
    ] },
    { label: t('Sicherheit'), icon: 'shield', content: [
      h('div', { class: 'grid2' },
        field(t('Automatisch sperren nach (Minuten)'), autoLock, t('0 = nur beim Sperren des Computers')),
        field(t('Zwischenablage leeren nach (Sekunden)'), clip, t('0 = nie'))),
      section(t('App-PIN'),
        h('p', { class: 'muted small' }, st.pinSet
          ? t('Eine PIN ist gesetzt und wird beim Entsperren abgefragt.')
          : `${t('Keine PIN – jeder an diesem PC kann die App entsperren, solange Windows angemeldet ist.')} ${t('Tipp: Mit einer PIN (unter Einstellungen) entsperrst du ohne neues Microsoft-Fenster – deine Tresore erscheinen sofort.')}`),
        st.opened ? h('button', { type: 'button', class: 'btn small', onclick: () => pinDialog() }, icon('key', 14), st.pinSet ? t('PIN ändern') : t('PIN festlegen'))
          : h('p', { class: 'muted small' }, t('Zum Ändern zuerst entsperren.'))),
      section(t('Offline-Lesemodus'),
        h('label', { class: 'inline' }, offlineMirror, t('Einträge verschlüsselt für unterwegs spiegeln (nur lesen, PIN nötig)')),
        h('p', { class: 'muted small' }, st.pinSet
          ? t('Ohne Netzwerk zeigt Keevault den letzten Stand – nur lesen, keine Änderungen. Der Spiegel liegt AES-256-verschlüsselt im Profil; zum Öffnen braucht es dein Windows-Konto und die PIN. Er füllt sich beim nächsten Entsperren mit PIN.')
          : t('Dafür zuerst eine App-PIN festlegen – sie schützt den Offline-Speicher zusammen mit deinem Windows-Konto.'))),
    ] },
    { label: t('Anmeldung'), icon: 'user', content: [
      section(t('Microsoft Entra ID (Key-Vault-Tresore)'),
        st.account ? h('p', { class: 'muted small' }, t('Angemeldet als {user}', { user: st.account.username })) : h('p', { class: 'muted small' }, t('Keine IDs nötig: Melde dich einfach an und füge deine Key-Vault-Tresore hinzu.')),
        h('label', { class: 'inline' }, autoDiscover, t('Gefundene Keevault-Tresore automatisch verbinden')),
        h('p', { class: 'muted small' }, t('Verbindet nach der Anmeldung jeden Key Vault, der als Keevault-Tresor eingerichtet ist und auf den du Zugriff hast. Aus: Nur Tresore, die du selbst hinzufügst oder die deine Organisation vorgibt.')),
        field(t('Verzeichnis (Tenant)'), directory),
        field(t('Entsperren'), prompt),
        st.platform === 'win32' ? h('label', { class: 'inline' }, signInWindows, t('Anmeldung im Windows-Dialog (wie PowerShell/Azure CLI) statt im Browser')) : null,
        h('details', { open: st.ownApp || undefined }, h('summary', {}, t('Eigene App-Registrierung (optional)')),
          h('p', { class: 'muted small' }, t('Leer lassen für die Standard-Anmeldung. Eigene App-Registrierung: infra/Setup-KvPwSafe.ps1.')),
          h('div', { class: 'grid2' }, field(t('Tenant-ID'), tenant), field(t('Client-ID'), client))),
        st.signedIn ? h('p', { class: 'actions' }, h('button', { type: 'button', class: 'btn danger small', onclick: async () => {
          await call('signOut');
          render();
        } }, icon('logout'), t('Abmelden und Token-Cache löschen'))) : null),
    ] },
    { label: t('Integrationen'), icon: 'link', content: [
      section(t('Browser-Erweiterung'),
        h('label', { class: 'inline' }, browser, t('Datei-Tresore in der Browser-Erweiterung verfügbar machen')),
        h('p', { class: 'muted small' }, t('Registriert einen Native-Messaging-Host für Edge und Chrome (nur für dein Benutzerkonto). Die Erweiterung fragt beim ersten Zugriff nach deiner Zustimmung in dieser App.')),
        field(t('Erweiterungs-IDs'), extensionIds)),
      section(t('Windows-Passkey-Anbieter'),
        h('label', { class: 'inline' }, windowsProvider, t('Keevault als Passkey-Anbieter in Windows verwenden (wie 1Password)')),
        h('p', { class: 'muted small' }, t('Dann erscheint Keevault im Windows-Passkey-Dialog – auch für andere Browser und Apps. Jede Anmeldung bestätigst du in dieser App.')),
        h('p', { class: 'muted small' }, t('Für Edge und Chrome nicht nötig – dort nutzt die Browser-Erweiterung die Passkeys direkt. Beim Einschalten meldet Keevault seine Passkey-Komponente bei Windows an, beim Ausschalten wieder ab.')),
        windowsStatus),
      section(t('Abtippen (Auto-Type)'),
        field(t('Tastenkürzel, überall in Windows'), autoTypeKeys, t('Eintrag in der App auswählen, ins Zielfeld klicken, Kürzel drücken: U = Benutzername, P = Passwort, O = Einmalcode. Gilt nur, solange die App entsperrt ist; Strg+Umschalt überdeckt in Edge Vorlesen/InPrivate/Favoriten.'))),
      section(t('Einrichtung dieses Geräts'),
        machine,
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn small', onclick: async () => {
            try {
              const r = await call('windowsProviderRegister');
              toast(r.registered ? t('Bei Windows registriert') : t('Registrierung fehlgeschlagen ({code})', { code: r.hresult }), r.registered ? 'info' : 'error');
            } catch (e) {
              toast(e.message, 'error');
            }
          } }, t('Bei Windows registrieren')),
          h('button', { type: 'button', class: 'btn small', onclick: () => call('openWindowsPasskeySettings') }, t('Windows-Einstellungen öffnen')))),
    ] },
    { label: t('Ansicht'), icon: 'eye', content: [h('div', { class: 'view-settings' }, ...viewSettings())] },
    { label: t('KI-Agenten'), icon: 'wand', content: [
      section(t('KI-Agenten (MCP)'),
        h('label', { class: 'inline' }, mcpEnabled, t('KI-Agenten wie Claude oder GitHub Copilot anbinden (Model Context Protocol)')),
        h('p', { class: 'muted small' }, t('Agenten sehen beim Suchen nur Titel, Benutzer und URL. Passwörter lesen erlaubst du pro Sitzung, Einträge anlegen oder ändern bestätigst du jedes Mal. Löschen ist nicht möglich. Läuft Keevault nicht oder ist gesperrt, bekommt der Agent nichts.')),
        s.mcpEnabled ? h('div', {},
          field(t('Zugriff für KI-Agenten'), mcpMode, t('Freigeben geht auch per Rechtsklick auf einen Tresor oder Ordner. Ein freigegebener Ordner schließt seine Unterordner ein.')),
          h('div', { class: 'field' }, h('label', {}, t('Freigegeben')), scopeList,
            h('div', { class: 'inline' }, scopeVault, scopeFolder, scopeAdd)),
          // #308 / #315: off by default, every single use is confirmed in the app.
          h('div', { class: 'field' }, h('label', {}, t('Zusätzliche Rechte (jede Nutzung wird bestätigt)')),
            h('label', { class: 'inline' }, mcpPasskeys, t('Agenten dürfen sich mit gespeicherten Passkeys anmelden')),
            h('p', { class: 'muted small' }, t('Keevault signiert nur die einzelne Anmeldung für die Website des Passkeys (https); der Passkey selbst verlässt den Tresor nie.')),
            h('label', { class: 'inline' }, mcpMicrosoft, t('Tools dürfen eine Microsoft-Anmeldung anfordern')),
            h('p', { class: 'muted small' }, t('Keevault kommt nach vorne, du wählst das Konto – nur dieses bekommt das Tool.'))),
          mcpBox) : h('p', { class: 'muted small' }, t('Nach dem Einschalten und Speichern erscheinen hier die Einstellungen für deinen KI-Client.'))),
    ] },
  ]), [
    { label: t('Abbrechen') },
    { label: t('Speichern'), primary: true, onClick: async () => {
      const changedTenant = tenant.value.trim() !== s.tenantId || client.value.trim() !== s.clientId;
      await call('updateSettings', {
        language: language.value,
        tenantId: tenant.value.trim(),
        clientId: client.value.trim(),
        autoLockMinutes: Number(autoLock.value) || 0,
        clipboardSeconds: Number(clip.value) || 0,
        unlockPrompt: prompt.value,
        browserIntegration: browser.checked,
        windowsProvider: windowsProvider.checked,
        autoTypeKeys: autoTypeKeys.value,
        signInWindows: signInWindows.checked,
        startWithWindows: startWithWindows.checked,
        autoDiscover: autoDiscover.checked,
        settingsSync: settingsSync.checked,
        updateMode: updateMode.value,
        updateChannel: updateChannel.value === 'beta' ? 'beta' : 'stable',
        mcpEnabled: mcpEnabled.checked,
        offlineMirror: offlineMirror.checked && st.pinSet,
        mcpScope: mcpMode.value,
        mcpPasskeys: mcpEnabled.checked && mcpPasskeys.checked,
        mcpMicrosoft: mcpEnabled.checked && mcpMicrosoft.checked,
        extensionIds: extensionIds.value.split(/[\s,;]+/).filter((x) => /^[a-p]{32}$/.test(x)),
      });
      if (changedTenant && st.signedIn) await call('switchTenant', tenant.value.trim());
      toast(t('Gespeichert'));
      await render();
    } },
  ]);
  settingsDialogEl.classList.add('settings-modal');
}
