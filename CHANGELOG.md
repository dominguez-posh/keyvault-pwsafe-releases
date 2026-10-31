# Changelog

Ein Abschnitt pro Version, Deutsch zuerst, die englische Liste unter `### English`. `scripts/release-notes.mjs` hängt den
Abschnitt der aktuellen Version als `releaseNotes` an `release/latest.yml` (wird mitsigniert) und nutzt ihn als Text des
GitHub-Releases; die App zeigt ihn im Update-Dialog. Ohne Abschnitt für die Version bricht das Release ab.

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
