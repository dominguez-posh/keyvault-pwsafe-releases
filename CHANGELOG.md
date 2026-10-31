# Changelog

Ein Abschnitt pro Version, Deutsch zuerst, die englische Liste unter `### English`. `scripts/release-notes.mjs` hängt den
Abschnitt der aktuellen Version als `releaseNotes` an `release/latest.yml` (wird mitsigniert) und nutzt ihn als Text des
GitHub-Releases; die App zeigt ihn im Update-Dialog. Ohne Abschnitt für die Version bricht das Release ab.

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
