# Changelog

Ein Abschnitt pro Version, Deutsch zuerst, die englische Liste unter `### English`. `scripts/release-notes.mjs` hängt den
Abschnitt der aktuellen Version als `releaseNotes` an `release/latest.yml` (wird mitsigniert) und nutzt ihn als Text des
GitHub-Releases; die App zeigt ihn im Update-Dialog. Ohne Abschnitt für die Version bricht das Release ab.

## 0.7.18 – 2026-10-31
- Neues, modernes Design (hell und dunkel): Liste und Details als helle Karte mit großen Radien, Felder eines Eintrags als Karte mit Trennlinien, Filter-Pillen (Alle, Logins, Passkeys, Notizen …), zentrierter Sperrbildschirm und KI-Agent-Dialog, aufgeräumtes Popup der Erweiterung.
- Tresore in der Seitenleiste: Anzahl neben der Überschrift; bei mehr als fünf Tresoren erscheinen „Tresore suchen“ und eine eigene Scrollleiste.
- Neues Setup im Keevault-Design: Begrüßung, Installation mit sich füllendem Schild und „Keevault ist bereit“ – ohne klassischen Installations-Assistenten, ohne Administratorrechte.
- Updates ohne Fensterwechsel: Statt dass die App verschwindet und wieder auftaucht, erscheint an derselben Stelle „Keevault wird aktualisiert“ mit Fortschritt, danach startet Keevault mit „Aktualisiert auf …“. Im Hintergrund (gesperrt oder im Infobereich) bleibt das Update unsichtbar.
- Browser-Erweiterung: Der Passkey-Anhänger hängt jetzt oben in der Mitte, ist symmetrisch aufgebaut und zeigt das Keevault-Logo.
- Fortschrittskarte beim Abgleich: zeigt den laufenden Schritt (Schnell-Index, Secrets auflisten mit Seite und Anzahl, Zugriffsrechte, Ergebnis) und die Laufzeit. Mit der Maus darüber klappt sie auf: alle Schritte mit Dauer und ein Hinweis, wenn gelöschte Secrets die Auflistung bremsen. Das Diagnoseprotokoll vermerkt lange Auflistungen mit ihrer Seitenzahl.

### English
- New, modern design (light and dark): list and details as one card with large radii, an entry's fields as a card with dividers, filter pills (all, logins, passkeys, notes …), centred lock screen and AI agent dialog, tidier extension popup.
- Vaults in the sidebar: count next to the heading; with more than five vaults “Search vaults” and a scroll area of their own appear.
- New setup in Keevault's design: welcome, installation with a filling shield and “Keevault is ready” – no classic setup wizard, no administrator rights.
- Updates without a window jump: instead of the app disappearing and reappearing, “Updating Keevault” with progress appears in the same place, then Keevault starts with “Updated to …”. In the background (locked or in the notification area) the update stays invisible.
- Browser extension: the passkey tag now hangs top center with a symmetric layout and shows the Keevault logo.
- Progress card while reconciling: shows the running step (fast index, listing secrets with page and count, permissions, result) and the elapsed time. Hovering expands it: every step with its duration and a hint when deleted secrets slow the listing down. The diagnostics log notes long listings with their page count.

## 0.7.17 – 2026-10-31
- Zusätzliche Felder mit Feldtyp: Text, Verborgen, Mehrzeilig, Adresse (URL), E-Mail, Telefon, Zahl / PIN, Datum, Einmalcode (TOTP) und Datei. Dazu Vorlagen wie Lizenzschlüssel, API-Schlüssel, Wiederherstellungscodes, Sicherheitsfrage, Support-Telefon oder Vertragsende. Adressen sind anklickbar, Einmalcodes laufen live mit.
- Kleine Dateien als Anhang (bis 8 KB, z. B. eine TXT mit weiteren Infos): Textdateien werden direkt angezeigt, jede Datei lässt sich speichern. Die Grenze ergibt sich aus der Größe eines Key-Vault-Secrets.
- Browser-Erweiterung: Neuer Passkey-Dialog im Keevault-Stil – ein Anhänger hängt unter dem Keevault-Symbol, fällt herein und pendelt aus. Konto (bzw. Tresor beim Speichern) per Klick wechselbar, darunter „Anderes Gerät“ und „Abbrechen“. Beim Bestätigen zeichnet sich der Schild nach, bei Erfolg füllt er sich und bekommt einen Haken.

### English
- Additional fields with a field type: text, hidden, multi-line, address (URL), email, phone, number / PIN, date, one-time code (TOTP) and file. Plus templates such as license key, API key, recovery codes, security question, support phone or contract end. Addresses are clickable, one-time codes run live.
- Small files as attachments (up to 8 KB, e.g. a TXT with further information): text files are shown directly, every file can be saved. The limit comes from the size of one Key Vault secret.
- Browser extension: new passkey dialog in Keevault style – a tag hangs below the Keevault icon, drops in and swings out. Account (or vault when saving) switchable with a click, below “Other device” and “Cancel”. While confirming the shield draws itself, on success it fills and gets a check mark.

## 0.7.16 – 2026-10-31
- Zwischenablage: Kopieren funktioniert wieder überall (auch Einladungslink und Codes), wenn der Windows-Hilfsprozess blockiert ist (z. B. durch Sophos); jede Kopie bestätigt „… in die Zwischenablage kopiert“ oder meldet den Fehler.
- Viele Benutzer an einem Tresor: Der gemeinsame Schnell-Index wird nur noch geschrieben, wenn er im Tresor wirklich abweicht, und zeitlich gestreut – bei 50 gleichzeitigen Apps schreiben statt aller nur noch wenige (Lasttest: npm run loadtest).
- Update-Dialog: zeigt die Änderungen aller Versionen seit der installierten (auch übersprungene Updates), je Version mit Datum, als Aufzählung und in einem scrollbaren Bereich.

### English
- Clipboard: copying works everywhere again (invitation link and codes too) when the Windows helper process is blocked (e.g. by Sophos); every copy confirms “… copied to the clipboard” or reports the error.
- Many users on one vault: the shared fast index is only written when it really differs in the vault, spread over time – with 50 apps at once only a few write instead of all (load test: npm run loadtest).
- Update dialog: shows the changes of every version since the installed one (skipped updates too), per version with its date, as a list in a scrollable area.

## 0.7.15 – 2026-10-31
- Nach dem Speichern eines Passkeys öffnet sich das Popup der Erweiterung mit dem neuen Eintrag zum Bearbeiten (Titel, Ordner, Logo …). Braucht Edge/Chrome 127 oder neuer, sonst beim nächsten Öffnen des Popups.
- Browser-Erweiterung: Rechtsklick auf einen Eintrag im Popup öffnet ein eigenes Menü – Öffnen, Bearbeiten, Ausfüllen, Benutzername/Passwort kopieren, Löschen.
- Hängt eine Anfrage an Key Vault, wird sie nach 30 Sekunden abgebrochen und wiederholt, statt den Tresor endlos „laden“ zu lassen.
- Diagnose: offene Anfragen und Token-Abrufe nach 10 Sekunden sowie lange Ladezeiten je Tresor stehen im Diagnose-Log.

### English
- After saving a passkey the extension popup opens with the new entry in edit mode (title, folder, logo …). Needs Edge/Chrome 127 or later, otherwise the next time the popup opens.
- Browser extension: right-clicking an entry in the popup opens its own menu – open, edit, fill, copy user name/password, delete.
- A Key Vault request that hangs is aborted after 30 seconds and retried instead of keeping the vault “loading” forever.
- Diagnostics: requests and token requests still open after 10 seconds and long loading times per vault are written to the diagnostics log.

## 0.7.14 – 2026-10-31
- Das Passkey-Fenster der Erweiterung fragt bei gesperrter App ebenfalls direkt nach der PIN (wie Popup und Leiste).
- Entsperren mit PIN aus der Erweiterung holt die Desktop-App nicht mehr in den Vordergrund.

### English
- The extension's passkey window also asks for the PIN directly while the app is locked (like the popup and the bar).
- Unlocking with the PIN from the extension no longer brings the desktop app to the front.

## 0.7.13 – 2026-10-31
- Passkey-Anmeldung bei gesperrter App: Mit gesetzter PIN entsperrst du direkt in der Leiste oben in der Seite und meldest dich gleich dort an – ohne Fenster.
- Start aus der Browser-Erweiterung über die Windows-Shell statt als Unterprozess des Browsers (Sophos „Lockdown“ blockierte das).
- Logos automatisch: Legst du einen Eintrag über die Browser-Erweiterung an (Neu, Login speichern, Passkey speichern), wird das Favicon der Website zum Symbol – direkt von der Website, ohne fremden Logo-Dienst.
- Neue Einstellung „Mit Windows starten (im Infobereich)“: Die App ist für Erweiterung und KI-Agenten sofort da.

### English
- Passkey sign-in while the app is locked: with a PIN set you unlock right in the bar at the top of the page and sign in there – no window.
- Starting the app from the browser extension goes through the Windows shell instead of as a child of the browser (Sophos “Lockdown” blocked that).
- Logos automatically: entries created through the browser extension (New, save login, save passkey) get the website's favicon as icon – straight from the website, no third-party logo service.
- New setting “Start with Windows (in the notification area)”: the app is ready for the extension and AI agents right away.

## 0.7.12 – 2026-10-31
- Browser-Erweiterung: Passt die gespeicherte URL genauer zur Seite (z. B. keevault.de/admin), steht der Eintrag in „Diese Website“ und in der Passkey-Leiste ganz oben; alle anderen Einträge der Website bleiben sichtbar.
- Diagnose: Langsame oder fehlgeschlagene Anfragen an Key Vault und langsame Anmeldungen landen ohne Inhalte in `%APPDATA%\KeyVault PwSafe\diagnostics.log`.
- Wissen: Abschnitt „Passkeys für Microsoft Entra ID“ (synchronisierbare Passkeys erlauben, Keevault-AAGUID).
- Browser-Erweiterung: Auch das Speichern neuer Passkeys läuft in der Leiste oben in der Seite (Tresor über ▾ wählbar); die Animation sitzt oben mittig und erscheint nie mehr hinter einem Fenster.

### English
- Browser extension: when the stored URL fits the page more precisely (e.g. keevault.de/admin), the entry comes first in “This website” and in the passkey bar; all other entries of the website stay visible.
- Diagnostics: slow or failed Key Vault requests and slow sign-ins are written without content to `%APPDATA%\KeyVault PwSafe\diagnostics.log`.
- Docs: section “Passkeys for Microsoft Entra ID” (allow syncable passkeys, Keevault AAGUID).
- Browser extension: saving new passkeys also happens in the bar at the top of the page (vault selectable via ▾); the animation sits top centre and never hides behind a window again.

## 0.7.11 – 2026-10-31
- Die Fortschrittskarte beim Abgleich zeigt bei Tresoren mit vielen Secrets eine laufende Zahl statt einer vollen Leiste, die fertig aussah.
- Rückfragen von KI-Agenten (verbinden, Passwort lesen, Eintrag ändern) erscheinen als Dialog im Stil der App statt als Windows-Meldung; das Fenster kommt dabei nach vorn und bleibt im Vordergrund, bis du antwortest.
- Entwickler-Builds belegen nicht mehr die Verbindung der installierten App (Browser-Erweiterung, KI-Agenten).

### English
- The reconcile progress card shows a running count for vaults with many secrets instead of a full bar that looked finished.
- Questions from AI agents (connect, read a password, change an entry) appear as a dialog in the app's style instead of a Windows message box; the window comes to the front and stays on top until you answer.
- Development builds no longer take over the connection of the installed app (browser extension, AI agents).

## 0.7.10 – 2026-10-31
- Update-Dialog: Die EXE-Installation wurde fälschlich als MSI erkannt, deshalb fehlte der Button „Jetzt aktualisieren“ und die App konnte sich nie selbst aktualisieren. Dieses eine Mal bitte den Installer von Hand ausführen, danach läuft es automatisch.
- Browser-Erweiterung: Bei der Passkey-Anmeldung erscheint statt eines Fensters eine Leiste oben in der Seite – Konto, „Passkey verwenden“, bei mehreren Passkeys eine Liste, „Andere Optionen“ öffnet das bisherige Fenster, × übergibt an den Browser.
- Aktualisieren eines Tresors ist sofort fertig: zuerst der schnelle Index, der vollständige Abgleich und die Berechtigungen laufen danach im Hintergrund – mit Fortschrittskarte unten rechts (bei Tresoren mit vielen Secrets als laufende Zahl).
- KI-Agenten: Beim Lesen von Passwörtern gibt es jetzt „Für 1 Stunde“ und „Für 4 Stunden“. Die Freigabe gilt für den Agenten, auch wenn er pro Anfrage neu startet (z. B. Claude Code), und endet beim Sperren der App.
- Neue Richtlinien für GPO und Intune: Selbst-Update der App erlauben oder sperren (`SelfUpdate`), Standard-Tresor für neue Einträge, Datei-Tresore in der Browser-Erweiterung, Passkey-Anbieter in Windows, Anmeldung im Windows-Dialog, Zugriff für KI-Agenten, erlaubte Erweiterungs-IDs. ADMX-Vorlage, Intune-Skript und die Anleitung auf keevault.de sind erweitert.

### English
- Update dialog: the EXE installation was mistaken for an MSI, so the “Update now” button was missing and the app could never update itself. Run the installer by hand this one time; afterwards it works automatically.
- Browser extension: passkey sign-in shows a bar at the top of the page instead of a window – account, “Use passkey”, a list for several passkeys, “Other options” opens the previous window, × hands over to the browser.
- Refreshing a vault is done right away: the fast index first, the full reconcile and the permissions follow in the background – with a progress card bottom right (a running count for vaults with many secrets).
- AI agents: reading passwords now offers “For 1 hour” and “For 4 hours”. The grant applies to the agent even if it starts a new process per request (e.g. Claude Code) and ends when the app locks.
- New policies for GPO and Intune: allow or block the app's self-update (`SelfUpdate`), default vault for new entries, file vaults in the browser extension, passkey provider in Windows, sign-in through the Windows dialog, access for AI agents, allowed extension IDs. ADMX template, Intune script and the guide on keevault.de are extended.

## 0.7.9 – 2026-10-31
- Einstellungen aufgeräumt: fünf Reiter (Allgemein, Sicherheit, Anmeldung, Integrationen, KI-Agenten) statt einer langen Seite; der zuletzt geöffnete Reiter bleibt nach dem Speichern aktiv.
- Unter „Einrichtung dieses Geräts“ stand ein überflüssiges „null“.
- Browser-Erweiterung: QR-Code für Einmalcodes direkt von der Website scannen (Eintrag bearbeiten → Einmalcode → QR-Symbol). Das Bildschirmfoto bleibt in der Erweiterung.
- Passkeys: kurze Erfolgsanimation nach Anmeldung oder Speichern, in der Erweiterung und im Windows-Passkey-Dialog der App.

### English
- Settings tidied up: five tabs (General, Security, Sign-in, Integrations, AI agents) instead of one long page; the last opened tab stays active after saving.
- A stray “null” under “Set up this device” is gone.
- Browser extension: scan the QR code for one-time codes right from the website (edit entry → one-time code → QR icon). The screenshot never leaves the extension.
- Passkeys: short success animation after signing in or saving, in the extension and in the app's Windows passkey dialog.

## 0.7.8 – 2026-10-31
- Update direkt in der App: Keevault prüft beim Start, ob eine neue Version vorliegt, und bietet sie sofort an. Ein Klick lädt, installiert und startet neu („Später“ fragt beim nächsten Start wieder). Neuer Standard; in den Einstellungen abschaltbar.
- Der Update-Dialog zeigt, was in der neuen Version anders ist (dieser Changelog, Teil des signierten Update-Manifests).
- Release-Skripte: schonendere Dateioperationen (Sophos CryptoGuard hatte den Massen-Löschvorgang als Ransomware gemeldet) und Bau neben einem gesperrten `release\win-unpacked`.

### English
- Update inside the app: Keevault checks at start whether a new version exists and offers it right away. One click downloads, installs and restarts (“Later” asks again at the next start). New default; can be turned off in the settings.
- The update dialog shows what changed in the new version (this changelog, part of the signed update manifest).
- Release scripts: gentler file operations (Sophos CryptoGuard had reported the mass delete as ransomware) and building next to a locked `release\win-unpacked`.

## 0.7.7 – 2026-10-31
- Das Aktualisieren-Symbol neben dem Tresor dreht sich, solange der Tresor im Hintergrund abgeglichen wird.
- Beim ersten Start der App werden alle verbundenen Tresore aktualisiert.

### English
- The refresh icon next to the vault spins while the vault is being synchronised in the background.
- At the first start of the app all connected vaults are refreshed.
