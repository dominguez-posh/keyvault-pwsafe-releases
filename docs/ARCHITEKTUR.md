# Architektur

## Bausteine

| Teil | Ort | Aufgabe |
| --- | --- | --- |
| Kern | `extension/core/` | Key-Vault-Client, Azure-Client (Resource Graph, RBAC, Graph), Datenmodell, Sitzung, Passkey-Authenticator, TOTP, Generator, Import, UI-Bausteine. Nur Web-Standard-APIs (fetch, WebCrypto). |
| Erweiterung | `extension/` | Manifest V3. Service Worker (`background.js`), Inhaltsskripte, Popup, Passkey-/Entsperr-Dialog, Einstellungen, Offscreen-Dokument für die Zwischenablage. |
| Desktop-App | `desktop/` | Electron. Hauptprozess mit MSAL, Sitzung und API; Renderer in der Sandbox ohne Node und ohne Netzwerk. |
| Azure | `infra/` | App-Registrierung, Container anlegen (PowerShell), Bicep-Vorlage. |

Beide Clients sprechen direkt mit Entra ID und Key Vault. Es gibt keinen eigenen Server und keine Verbindung
zwischen Desktop-App und Erweiterung.

## Datenmodell

**Container** = Azure Key Vault mit RBAC-Autorisierung. Erkannt wird er über das Ressourcen-Tag
`kvpwsafe=container`, der Anzeigename steht in `kvpwsafe-name`. Die ID eines Containers in den Apps ist der
Hostname des Vaults (`kv-pws-ops.vault.azure.net`).

**Eintrag** = Secret `pws-<32 Hex-Zeichen>` mit Content-Type `application/vnd.kvpwsafe.item+json; v=1`.

Wert (JSON):

```json
{
  "v": 1, "type": "login", "title": "GitHub", "username": "alex", "password": "…",
  "urls": ["https://github.com/login"], "totp": "otpauth://…", "notes": "",
  "fields": [{ "name": "PIN", "value": "…", "hidden": true }],
  "passkeys": [{
    "credentialId": "<base64url>", "rpId": "github.com", "rpName": "GitHub",
    "userHandle": "<base64url>", "userName": "alex", "userDisplayName": "Alex",
    "algorithm": -7, "privateKey": "<base64url PKCS#8>", "publicKey": "<base64url SPKI>",
    "signCount": 0, "discoverable": true, "created": "2026-10-22T10:00:00Z"
  }],
  "folder": "Arbeit", "favorite": false,
  "created": "…", "createdBy": "alex@contoso.com", "updated": "…", "updatedBy": "alex@contoso.com"
}
```

Tags (für Listen ohne Werte): `kvpwsafe=item`, `t` Typ, `n` Titel, `u` Benutzername, `h` Hosts, `rp` Passkey-RP-IDs,
`f` Ordner, `fav`, `otp`. Andere Secrets im selben Vault werden ignoriert.

Jede Änderung erzeugt eine neue Secret-Version (Verlauf). Löschen ist Soft Delete (Papierkorb, 90 Tage).
Vor dem Speichern vergleicht die App die aktuelle Version mit der geladenen; bei Abweichung meldet sie einen
Konflikt statt zu überschreiben.

## Abläufe

### Entsperren

- **Erweiterung**: meldet sich nirgends an. Entsperrt wird in der Desktop-App; die Erweiterung holt sie dazu in den
  Vordergrund (oder startet sie) und macht weiter, sobald die App „entsperrt“ meldet.
- **Desktop**: MSAL Node, interaktiv im Systembrowser mit Loopback-Redirect `http://localhost`. Der Token-Cache ist
  mit `safeStorage` verschlüsselt (DPAPI unter Windows).
- Danach: Container ermitteln (Resource Graph + Richtlinie + manuell hinzugefügte), eigene Rechte je Container
  (`Microsoft.Authorization/permissions`), Liste aller Einträge aus den Tags.

### Ausfüllen

Das Inhaltsskript fragt beim Fokus auf ein Anmeldefeld den Service Worker nach Treffern. Den Ursprung nimmt
der Service Worker aus `sender.origin` (vom Browser), nie aus der Nachricht. Treffer: gleiche Domain oder
Subdomain der gespeicherten Website, keine Ähnlichkeitssuche. Das Passwort geht erst nach einem echten Klick
(`isTrusted`) und nur an den passenden Frame.

### Passkeys

```
Seite ── navigator.credentials.create/get ──▶ webauthn-main.js (MAIN-Welt)
         postMessage ──▶ content.js (isolierte Welt) ── runtime.sendMessage ──▶ background.js
         background.js prüft Ursprung + RP-ID, öffnet prompt.html (Container wählen / Passkey wählen)
         background.js erzeugt bzw. signiert (WebCrypto, ES256), speichert im Key Vault
         ── tabs.sendMessage ──▶ content.js ── postMessage ──▶ Seite erhält PublicKeyCredential
```

- Registrieren: Schlüsselpaar P-256, Attestation `none`, Flags UP, UV, BE und BS (synchronisierter Passkey),
  Zähler 0, AAGUID `6b767077-2d73-6166-65a1-c3e5f70d2b9e`. Der Passkey wird gespeichert, **bevor** die Website die
  Antwort bekommt.
- Anmelden: modal über den Dialog, mit `mediation: "conditional"` über das Auswahlmenü im Benutzerfeld, parallel
  zum Passkey-Menü des Browsers.
- An den Browser weitergereicht werden: andere Credential-Typen, fremde iframes, Sicherheitsschlüssel
  (`cross-platform`, Hint `security-key`), Algorithmen ohne ES256, abgeschaltete Passkey-Funktion, keine passenden
  Passkeys, nicht erreichbare Erweiterung (Zeitlimit) und „Anderes Gerät verwenden“.

### Teilen

Freigeben = Rollenzuweisung auf dem Key Vault (siehe README). Die Desktop-App listet die Zuweisungen
(`atScope()`, geerbte werden markiert), löst Namen über Graph auf und legt Zuweisungen an oder entfernt sie.
Zusätzlich vergibt sie „Leser“, damit der Container beim Empfänger automatisch erscheint. Wer nur
*Key Vault Data Access Administrator* ist, darf „Leser“ nicht vergeben; dann hilft der Einladungslink.

## Nachrichten der Erweiterung

- Erweiterungsseiten (Popup, Dialog, Einstellungen) dürfen alle Befehle senden.
- Inhaltsskripte nur `cs:*`: Treffer für den eigenen Ursprung, Ausfüllen eines passenden Eintrags,
  Speichern-Angebot, Passkey-Anfragen für den eigenen Tab und Frame.
- Offene Passkey-Anfragen liegen in `chrome.storage.session`, damit ein Neustart des Service Workers sie nicht
  verliert; das Schließen des Dialogfensters bricht die Anfrage ab (`NotAllowedError`).

## Container-Arten

| Art | Speicher | Zugriff | Verschlüsselung |
| --- | --- | --- | --- |
| `keyvault` | Azure Key Vault | Entra ID + Azure RBAC | Key Vault; optional zusätzlich clientseitig |
| `file` | `.kvpws`-Datei (Desktop-App) | Dateisystem | immer clientseitig |
| `remote` | jeder Tresor der Desktop-App (Key Vault oder Datei), aus Sicht der Erweiterung | Native Messaging | in der Desktop-App |

`core/session.js` (Desktop-App) behandelt `keyvault` und `file` gleich; Datei-Container kommen über einen Adapter
(`desktop/files.js`). Die Erweiterung nutzt `extension/lib/desktop.js` mit denselben Methodennamen.

## Schlüsselbund (keyring)

Ein zufälliger Container-Schlüssel (AES-256-GCM) verschlüsselt die Einträge. Der Schlüsselbund enthält ihn
einmal pro Entsperrmethode verpackt (AES-GCM, zusätzliche Daten = Container-ID, Eintrags-ID und Typ):

| Typ | Schlüssel zum Verpacken |
| --- | --- |
| `password` | PBKDF2-SHA-256, 600 000 Runden, 16 Byte Salt → HKDF |
| `passkey` | WebAuthn-PRF-Ausgabe (je Passkey eigener Salt) → HKDF; RP-ID = Erweiterungs-ID bzw. `localhost` (Desktop) |
| `recovery` | 160-Bit-Code `RK-…` → HKDF |
| `invite` | 160-Bit-Code `IN-…`, 7 Tage gültig, wird nach dem ersten Entsperren durch eigene Methoden ersetzt |

Key Vault: Secret `pws-keyring` (Tag `kvpwsafe=keyring`); Einträge werden als `{"kvpwsafe-sealed":1,"data":…}`
gespeichert, die Tags `n`, `u`, `h`, `rp`, `f`, `fav`, `otp` einzeln verschlüsselt (Tag `e=1`). Beim Einschalten
werden vorhandene Einträge verschlüsselt neu angelegt und die alten gelöscht (und, wo erlaubt, endgültig entfernt).

## Dateiformat (.kvpws)

```json
{ "format": "kvpwsafe-file", "version": 1, "id": "file-<uuid>", "name": "Team", "keyring": { … },
  "items": { "pws-…": { "rev": "…", "updated": 1730000000000, "updatedBy": "alex", "data": "<AES-GCM>",
                         "history": [ … bis 10 Versionen … ], "deleted": false } } }
```

Speichern liest die Datei neu, führt pro Eintrag zusammen (neuere Änderung gewinnt, Löschungen als Grabstein)
und schreibt atomar (temporäre Datei + Umbenennen). Schlüsselbund-Einträge werden vereinigt, Entfernungen bleiben
erhalten. Die Desktop-App beobachtet die Datei und lädt Änderungen anderer Benutzer nach.

## Desktop-App ↔ Erweiterung

```
Erweiterung ── connectNative("com.kvpwsafe.desktop") ──▶ host.cmd → host.cjs (Electron als Node)
host.cjs ── Named Pipe \\.\pipe\kvpwsafe-<benutzer> (Unix: Socket im Profil) ──▶ Desktop-App
```

Die Erweiterung hat keine eigene Verbindung zu Azure: alle Daten kommen über diesen Weg aus der laufenden App.
Der Service Worker hält einen Port offen; der Host lebt so lange, meldet `online`/`offline` (App erreichbar oder
nicht), beantwortet Anfragen ohne App sofort mit `AppOffline`, verbindet sich selbst neu, sobald die App wieder
läuft, und startet sie auf `launch`. Die Liste der Tresore und Einträge holt die Erweiterung als ein `snapshot`
(aus dem Cache der App, veraltete Tresore lädt die App danach nach) und verwirft ihn bei jedem `changed` der App –
Änderungen im Browser oder in der App sind so sofort auf beiden Seiten sichtbar.

Die Desktop-App registriert den Host nur für den eigenen Benutzer (HKCU bzw. Profilordner) und nur für die
eingetragenen Erweiterungs-IDs. Die Herkunft der Erweiterung übergibt der Browser beim Start des Hosts; jede
Herkunft muss einmal in der Desktop-App erlaubt werden. Datei-Container entsperrt man in der Desktop-App.
