# Sicherheitsmodell

## Auf einen Blick

| Frage | Antwort |
| --- | --- |
| Wo liegen die Daten? | Im **eigenen Azure Key Vault** des Kunden (ein Secret pro Eintrag) oder in einer verschlüsselten Datei. Keevault betreibt keinen Server, über den Einträge laufen. |
| Clientseitig verschlüsselt? | **Optional**: „Zusätzlich schützen“ verschlüsselt Inhalt *und* Metadaten im Client (AES-256-GCM), entsperrt per Masterpasswort oder Passkey. Ohne diese Option schützen Entra ID, Azure RBAC und Key Vault. Für Break-Glass-, Global-Admin- und Infrastruktur-Zugänge empfehlen wir die Option. |
| Wer kann ohne Zusatzschutz mitlesen? | Jede Identität mit einer Key-Vault-Datenrolle auf dem Tresor, und wer sich eine solche Rolle geben kann (Besitzer, Benutzerzugriffsadministrator). |
| Sichtbare Metadaten? | Ohne Zusatzschutz stehen Titel, Benutzername, Websites und Ordner als **Secret-Tags im Klartext** (Rollen mit Metadaten-Leserecht wie *Key Vault Reader* sehen sie, aber keine Passwörter). Secret-Namen sind technisch (`pws-<zufällige ID>`). |
| Anmeldung | Microsoft Entra ID, öffentlicher Client mit PKCE (Systembrowser oder Windows-Broker), **kein Client Secret**, kein ROPC. Token-Cache mit DPAPI verschlüsselt. |
| Passkeys | **Software-Passkeys**: Der private Schlüssel liegt im Eintrag, ist synchronisiert und exportierbar, nicht hardwaregebunden, ohne Attestation (Details unten). |
| Telemetrie | **Keine.** Verbindungen nach außen: Microsoft (Anmeldung, Azure, Graph, Key Vault), keevault.de (Updates, Lizenzen), GitHub (Downloads), optional Have I Been Pwned (k-Anonymität). |
| Updates | Signiertes Update-Manifest (Ed25519), Hash-Prüfung des Installers, SBOM und SHA-256-Prüfsummen je Release. **Noch kein öffentlich vertrauenswürdiges Code-Signing-Zertifikat** (siehe Lieferkette). |
| Reifegrad | Kein externer Penetrationstest und kein unabhängiges Code-Review bisher. Für produktive Hochrisiko-Zugänge siehe „Einsatzempfehlung“. |

## Grundsatz

Ohne „Zusätzlich schützen“ hat ein Key-Vault-Tresor **kein Masterpasswort und keine eigene Verschlüsselungsschicht**.
Vertraulichkeit und Zugriffskontrolle kommen dann von Azure:

- **Entra ID** authentifiziert (MFA, Conditional Access, Anmeldehäufigkeit, konforme Geräte, phishing-resistente
  Methoden wie FIDO2 oder Windows Hello for Business).
- **Azure RBAC** entscheidet serverseitig, wer welchen Tresor lesen oder ändern darf. Ein manipulierter Client
  bekommt nicht mehr, als die Rolle des Benutzers erlaubt.
- **Key Vault** verschlüsselt im Ruhezustand (HSM-gestützte Schlüssel), versioniert jede Änderung und schützt
  vor dem Löschen (Soft Delete, Löschschutz).
- **Audit**: Jeder Zugriff (wer hat welches Secret wann gelesen) steht in den Key-Vault-Diagnoseprotokollen,
  wenn sie aktiviert sind (`-LogAnalyticsWorkspaceId` bzw. Bicep-Parameter).

Das ist ein bewusster Unterschied zu 1Password oder Bitwarden (Zero Knowledge): Wer in Azure die Rollen eines
Key Vaults ändern kann (Besitzer, Benutzerzugriffsadministrator, Key Vault Data Access Administrator), kann
sich selbst Zugriff geben. Wer das ausschließen will, nutzt „Zusätzlich schützen“ (siehe unten). Empfehlungen:

- Tresore in ein eigenes Abonnement oder eine eigene Ressourcengruppe mit wenigen, per **PIM** zeitlich
  begrenzten Besitzern legen.
- Diagnoseprotokolle aktivieren und auf Rollenänderungen sowie ungewöhnliche Lesezugriffe alarmieren
  (Azure Monitor); **Microsoft Defender for Key Vault** einschalten.
- Für die App eine **Conditional-Access-Richtlinie** anlegen: phishing-resistente MFA, konformes Gerät, Anmeldehäufigkeit
  (am besten mit eigener App-Registrierung, siehe „Anmeldung“).
- Key Vault Firewall bzw. Private Endpoint, wenn nur aus dem Firmennetz zugegriffen werden soll (die Clients
  brauchen dann Netzwerkzugang zum Vault – mobile Nutzung ohne VPN entfällt; ein bewusster Abwägungspunkt).
- **Löschschutz (Purge Protection)** aktiviert lassen; die App schlägt ihn beim Anlegen vor. Er verhindert, dass ein
  kompromittiertes Konto Daten endgültig löscht.
- Getrennte Tresore für Test und Produktion, und für persönliche bzw. hochprivilegierte Zugänge.

## Datenhaltung im Key Vault

- **Ein Secret pro Eintrag.** Der Name ist technisch (`pws-` plus zufällige ID) und verrät nichts über den Inhalt.
- **Im Secret-Wert** (JSON): Titel, Benutzername, Passwort, Websites, Notizen, Einmalcode-Geheimnis (TOTP),
  zusätzliche Felder und Anhänge, Passkeys (inkl. privatem Schlüssel), Kreditkarten- und Zertifikatsdaten.
- **In Tags** (damit Listen ohne Lesen jedes Werts laden): Titel, Benutzername bzw. letzte vier Kartenziffern,
  Websites, Ordner, Favorit, Ablaufdatum, ob ein Einmalcode/Logo existiert. Tags sind **ohne Zusatzschutz Klartext**
  und für Rollen mit Metadaten-Leserecht sichtbar (z. B. *Key Vault Reader*, auch ohne Leserecht auf Werte). Die App
  zeigt das in den Tresor-Infos an. Mit „Zusätzlich schützen“ sind die Tags verschlüsselt.
- **Schnell-Index** (`pws-index*`): eine Zusammenfassung der Liste als Secret-Wert, damit große Tresore schnell
  laden; lesbar nur mit Leserecht auf Werte.
- **Tresor-Einstellungen** (Ordner, Richtlinien, Lizenz) liegen ebenfalls als Secrets im Tresor, ohne Passwörter.

## Anmeldung (Entra ID)

- **Öffentlicher Client** (Desktop-App), Authorization Code Flow mit **PKCE** über den Windows-Broker (WAM) oder den
  Systembrowser mit Loopback-Umleitung. **Kein Client Secret** in der App, **kein ROPC** (Passwort-Weitergabe).
  Conditional Access und MFA gelten vollständig.
- **Token-Cache:** MSAL-Cache mit DPAPI verschlüsselt (Electron `safeStorage`), nur für den eigenen Windows-Benutzer
  lesbar. Sperren verwirft das Konto im Speicher. Die Erweiterung hält Tokens nur im Arbeitsspeicher.
- **Angeforderte Rechte** (delegiert, im Namen des Benutzers): Key Vault (`user_impersonation`), Azure Resource
  Manager (`user_impersonation`, zum Finden der Tresore und für Rollen) und Microsoft Graph (`.default`, also die für
  die App-Registrierung zugestimmten delegierten Rechte; Keevault nutzt sie nur für das eigene Profil und die
  Personen- und Gruppensuche beim Teilen). Keine Anwendungsberechtigungen. Mit eigener App-Registrierung legt der
  Kunde genau fest, welche Graph-Rechte zugestimmt sind (empfohlen: `User.Read`, `User.ReadBasic.All`, `GroupMember.Read.All`).
- **App-Registrierung:** Ohne eigene Registrierung meldet sich Keevault mit der **öffentlichen Client-ID der Azure CLI**
  an (Microsoft-Erstanbieter-App). Das funktioniert ohne Einrichtung, Conditional Access lässt sich dann aber nur auf
  „Azure CLI“ zuschneiden, nicht gezielt auf Keevault, und das Graph-Token trägt die Rechte der Azure CLI. **Empfehlung für Unternehmen:** eine eigene, einmandantenfähige
  App-Registrierung (öffentlicher Client, Umleitung `http://localhost` und Broker-URI) anlegen und per Richtlinie
  (`ClientId`, `TenantId`) verteilen – dann gelten eigene Conditional-Access-Regeln, Zustimmung und Sperre nur für Keevault.

## Rollen und Least Privilege

- Die App nutzt beim Teilen die eingebauten Rollen *Key Vault Secrets User* (lesen) und *Key Vault Secrets Officer*
  (bearbeiten). Der Officer darf mehr als nötig (u. a. endgültig löschen).
- **Schmalere eigene Rollen** liefert jedes Release mit (Richtlinien-Paket, Ordner `roles`): *Keevault User*
  (lesen, anlegen, ändern, löschen, aus Keevault-Backups wiederherstellen – kein Purge, keine Schlüssel, Zertifikate,
  Rollen oder Tresor-Einstellungen) und *Keevault Reader* (nur lesen). Anleitung in `installer/policy/roles/README.md`.
- Verwaltung (Rollen vergeben, Tresor-Einstellungen) bleibt bei *Key Vault Administrator* bzw. Besitzer –
  nur per **PIM** und zeitlich begrenzt. Für Auditoren genügt Zugriff auf die Diagnoseprotokolle, keine Datenrolle.
- Die App selbst braucht keine Rechte für Rollen, Netzwerkregeln, Schlüssel oder das Löschen des Tresors; sie nutzt
  immer die Rechte des angemeldeten Benutzers. „Mir selbst Zugriff geben“ funktioniert nur, wenn der Benutzer in
  Azure ohnehin Rollen vergeben darf.

## Clients

| Thema | Erweiterung | Desktop-App |
| --- | --- | --- |
| Tokens | nur im Arbeitsspeicher (`chrome.storage.session`), weg bei Browserende und Sperren | MSAL-Cache verschlüsselt mit DPAPI (`safeStorage`); Sperren verwirft das Konto im Speicher |
| Entsperren | Entra-Anmeldung; Einstellung *Konto bestätigen* (Standard), *Immer neu anmelden* oder *SSO* | dieselben drei Stufen, optional App-PIN |
| Automatisch sperren | Inaktivität (Standard 30 min), Bildschirmsperre | Inaktivität (Standard 15 min), Bildschirmsperre, Ruhezustand |
| Zwischenablage | wird nach 30 s geleert, wenn sie noch den kopierten Wert enthält | ebenso, zusätzlich ohne Verlauf und Cloud (siehe unten) |
| Lokale Daten | keine Secrets auf der Festplatte | keine Secrets auf der Festplatte |

Ohne Masterpasswort hängt die Sperre an der Entra-Anmeldung. Auf einem entsperrten Rechner mit gültiger
Browsersitzung genügt bei *Konto bestätigen* ein Klick. Wer strenger sein will, stellt *Immer neu anmelden* ein
(per Richtlinie erzwingbar), verlangt eine App-PIN oder setzt die Anmeldehäufigkeit per Conditional Access.

## Ausfüllen

- Treffer nur für dieselbe Domain oder eine Subdomain der gespeicherten Website, keine „ähnlichen“ Domains.
  Eine Phishing-Seite bekommt keine Vorschläge.
- Der Ursprung kommt vom Browser (`sender.origin`), nicht von der Seite. Passwörter gehen nur an Frames mit
  passendem Ursprung und erst nach einer echten Benutzeraktion.
- Das Auswahlmenü liegt in einem geschlossenen Shadow DOM der isolierten Welt; Klicks aus Seitenskripten
  (`isTrusted = false`) werden ignoriert.

## Passkeys – Threat Model

**Was Keevault-Passkeys sind:** echte WebAuthn-Credentials (ES256), die Websites wie jeden anderen Passkey prüfen –
aber **Software-Schlüssel**, keine Hardware-Schlüssel.

- **Erzeugung:** Der Schlüssel entsteht im Client (Erweiterung bzw. Desktop-App, WebCrypto) und wird mit dem Eintrag
  im Key Vault gespeichert. Er ist **nicht hardwaregebunden und exportierbar**: Wer den Eintrag lesen darf, kann den
  Passkey nutzen oder kopieren. So funktioniert gemeinsames Arbeiten mit geteilten Konten; persönliche Passkeys
  gehören in einen persönlichen Tresor, hochsensible in einen Tresor mit „Zusätzlich schützen“.
- **Synchronisierung:** über den Tresor; Passkeys melden „synchronisiert“ (Backup Eligible/State). Websites, die nur
  gerätegebundene Passkeys zulassen, lehnen sie ab – dann „Anderes Gerät“ (z. B. Windows Hello, Sicherheitsschlüssel).
- **Klonen:** ist bei geteilten Passkeys gewollt; der Signaturzähler bleibt 0, damit parallele Nutzung keine
  Fehlalarme auslöst. Websites können geklonte Software-Passkeys daher nicht erkennen.
- **Attestation:** keine (Format `none`). Websites, die eine bestimmte Hardware verlangen, lehnen Keevault-Passkeys ab.
- **Prüfung des Ursprungs:** Die RP-ID wird nach WebAuthn-Regeln gegen den Ursprung geprüft (gleiche oder übergeordnete
  Domain, HTTPS, keine IP-Adressen). `clientDataJSON` baut die Erweiterung mit dem vom Browser gemeldeten Ursprung.
- **User Presence:** Jede Registrierung und jede modale Anmeldung braucht eine Bestätigung im Keevault-Dialog
  (Anhänger im Browser bzw. Dialog der App). Bei Conditional UI ist die Auswahl im Menü die Bestätigung.
- **User Verification (UV)** meldet Keevault als erfüllt: Der Benutzer hat sich bei Entra ID (und ggf. mit App-PIN)
  angemeldet. Websites, die UV verlangen, verlassen sich damit auf diese Anmeldung und die Sperrzeit – nicht auf eine
  biometrische Prüfung je Anmeldung.
- **Windows-Anbieter:** siehe unten; Windows signiert jede Anfrage, die App bestätigt jede Nutzung.

## Zwischenablage, Arbeitsspeicher, Absturzabbilder

- Kopieren in der Desktop-App setzt die Windows-Kennzeichen `ExcludeClipboardContentFromMonitorProcessing`,
  `CanIncludeInClipboardHistory = 0` und `CanUploadToCloudClipboard = 0`: kein Zwischenablageverlauf (Win+V), keine
  Cloud-Zwischenablage. Ist der PowerShell-Hilfsprozess blockiert (Endpoint-Schutz, *Constrained Language Mode*),
  setzt das mitgelieferte `Keevault-Update.exe --clipboard` dieselben Kennzeichen. Nur wenn beides scheitert, landet
  der Wert ohne Kennzeichen in der Zwischenablage; das Diagnoseprotokoll vermerkt es.
- Nach der eingestellten Zeit (Standard 30 s) wird die Zwischenablage geleert, wenn sie noch den Wert enthält.
  Abtippen (Auto-Type) nutzt die Zwischenablage gar nicht. Die Browser-Erweiterung kann die Kennzeichen nicht
  setzen – dort besser Ausfüllen nutzen.
- Klartext wird nur für die Anzeige bzw. die Aktion geladen; die Liste kennt nur Zusammenfassungen ohne Passwörter.
  „Anzeigen“ blendet ein Passwort nur bis zum Verlassen des Eintrags ein; Sperren verwirft alle Einträge und Schlüssel
  im Speicher. Werte an Hilfsprozesse gehen nur über stdin, nie über Kommandozeilen.
- **Absturzabbilder:** Der Chromium-Absturzberichter ist abgeschaltet, alte Abbilder (`Crashpad`) werden beim Start
  gelöscht, und Keevault.exe ist von der Windows-Fehlerberichterstattung ausgenommen (`WerAddExcludedApplication`).
- **Grenzen:** JavaScript-Strings lassen sich nicht sicher überschreiben; Inhalte im Arbeitsspeicher können über die
  Auslagerungsdatei auf die Platte gelangen. Gegen Schadsoftware im angemeldeten Benutzerkonto schützt keine App
  vollständig.

## Protokolle, Telemetrie und Verbindungen nach außen

- **Keine Telemetrie.** Keevault sendet keine Nutzungsdaten.
- **Diagnoseprotokoll** (`%APPDATA%\KeyVault PwSafe\diagnostics.log`, nur lokal): langsame oder fehlgeschlagene
  Anfragen mit Methode, Tresor-Adresse, Pfad (Secret-ID), Status und Dauer, Hinweise wie „Zwischenablage ohne
  Kennzeichen“. **Keine** Secret-Werte, Passwörter, Tokens, Schlüssel oder Eintragsinhalte.
- **Agenten-Protokoll** (`mcp-audit.log`, nur lokal, nur wenn KI-Agenten eingeschaltet sind): welcher Agent wann
  welchen Eintrag (Titel, Tresor) gelesen oder geändert hat – zur Nachvollziehbarkeit, ohne Passwörter.
- **Verbindungen:** `login.microsoftonline.com` (Anmeldung), `*.vault.azure.net` (Einträge),
  `management.azure.com` (Tresore finden, Rollen), `graph.microsoft.com` (Personen/Gruppen beim Teilen),
  `keevault.de` (Update-Prüfung, Lizenzen, Downloads), `github.com` (Download der Installer),
  optional `api.pwnedpasswords.com` (Passwort-Check: nur die ersten 5 Zeichen des SHA-1-Hashes, k-Anonymität).
  Die Erweiterung lädt beim Anlegen eines Eintrags das Favicon der gerade geöffneten Seite.
- **Was den Tenant verlässt:** Einträge nie. keevault.de sieht bei der Update-Prüfung IP-Adresse und Version, bei
  Lizenzen den Lizenzcode des Tresors (eine Prüfsumme aus der Tresor-Adresse, nicht die Adresse selbst).

## Löschen, Wiederherstellen, Export

- Löschen nutzt das **Soft Delete** von Key Vault: Der Eintrag lässt sich während der Aufbewahrungsfrist des Tresors
  (7–90 Tage) wiederherstellen – im **Papierkorb** von Keevault (Rechtsklick auf den Tresor) oder im **Azure-Portal**
  (Key Vault → Secrets → Verwaltete gelöschte Secrets). Der Löschdialog nennt die Frist. Endgültiges Löschen aus dem
  Papierkorb erlauben die Tresor-Einstellungen nur, wenn ein Admin es freigibt; mit Löschschutz geht es erst nach Ablauf
  der Frist. Datei-Tresore behalten gelöschte Einträge in ihrem Papierkorb, bis sie dort endgültig gelöscht werden.
- **Verschlüsselte Backups** (Tresor-Menü): AES-256-GCM, Schlüssel per PBKDF2 aus einem generierten Passwort; nur für
  Besitzer der Subscription.
- **Export als CSV** schreibt die Einträge **im Klartext** in eine Datei. Tresor-Admins können den Export in den
  Tresor-Einstellungen abschalten; die Datei danach sicher löschen.

## Bekannte Restrisiken

- Klartext-Tags ohne Zusatzschutz (siehe Datenhaltung).
- Eine kompromittierte Browsersitzung bzw. ein kompromittiertes Benutzerkonto mit entsperrtem Tresor kann alle
  Einträge der freigegebenen Tresore lesen – wie bei jedem Passwortmanager.
- Wer Rollen auf dem Key Vault ändern darf, kann sich ohne Zusatzschutz Lesezugriff geben.
- Software-Passkeys sind kopierbar (siehe Passkeys).
- Noch kein öffentlich vertrauenswürdiges Code-Signing-Zertifikat (siehe Lieferkette).

## Zusätzlicher Schutz und Datei-Tresore

Mit zusätzlichem Schutz (Key Vault) bzw. bei Datei-Tresoren verschlüsselt der Client alle Einträge selbst –
Werte und Tags. Wer nur Zugriff auf den Key Vault oder die Datei hat – auch ein Azure-Administrator –, sieht nur
Chiffretext.

- **Verfahren:** zufälliger Tresor-Schlüssel (AES-256-GCM, eindeutige Nonce je Verschlüsselung), je Entsperrmethode
  verpackt; Ableitungen über HKDF-SHA-256.
- **Entsperrmethoden** sind gleichwertig: Masterpasswort (PBKDF2-SHA-256, 600 000 Runden), Passkeys mit PRF (FIDO2-
  Schlüssel, Smartphone, Windows Hello), Wiederherstellungsschlüssel (160 Bit) und befristete Einladungen.
  Ein starkes Masterpasswort ist Pflicht, wenn es genutzt wird – es schützt gegen Offline-Angriffe.
  (PBKDF2 statt Argon2id, weil es in allen Browsern nativ verfügbar ist; die Rundenzahl folgt der OWASP-Empfehlung.)
- **Wiederherstellungsschlüssel** sicher und getrennt aufbewahren: Ohne ihn sind die Daten verloren, wenn alle
  Passkeys und das Masterpasswort fehlen. Niemand kann sie zurückholen.
- **Einladungscodes** getrennt von der Datei weitergeben; sie gelten 7 Tage und werden nach der ersten Nutzung
  durch die eigenen Methoden der Person ersetzt.
- **Entfernen von Personen**: Der Passkey bzw. die Einladung verliert sofort die Wirkung. Wer den
  Tresor-Schlüssel vorher aus dem Speicher ausgelesen hat, könnte alte Kopien weiter lesen; ein Schlüsselwechsel
  ist für Key-Vault-Tresore noch nicht eingebaut. Wichtige Passwörter nach dem Ausscheiden ändern.
- **Sichtbare Metadaten**: Tresor-Name, Anzahl der Einträge, Zeitstempel und die Bezeichnungen der Passkeys
  (z. B. „Alex – YubiKey“) stehen unverschlüsselt in der Datei bzw. im Key Vault.
- **Wer schreiben darf, kann manipulieren**: Veränderte Einträge fallen beim Entschlüsseln auf (AES-GCM);
  unverschlüsselt eingeschleuste Einträge zeigt die App als „unverschlüsselt“ an.
- Entsperrte Tresor-Schlüssel liegen nur im Arbeitsspeicher (Erweiterung: `chrome.storage.session`) und werden
  beim Sperren verworfen.

## Desktop-App ↔ Erweiterung

Der Native-Messaging-Host ist nur für den eigenen Windows-Benutzer registriert und nur für die eingetragenen
Erweiterungs-IDs startbar. Die Named Pipe lässt andere Benutzer nicht schreiben. Jede Browser-Herkunft muss in
der Desktop-App einmal erlaubt werden. Gegen Schadsoftware, die als derselbe Benutzer läuft, schützt das – wie
bei jedem Passwortmanager – nicht.

## Updates, Programmintegrität und Lieferkette

- **Signierte Update-Manifeste:** Neue Versionen erfährt die App nur über `latest.yml`, das beim Release mit einem
  Ed25519-Schlüssel signiert wird, der ausschließlich auf dem Build-Rechner liegt (`latest.yml.sig`). Ein Manifest
  ohne gültige Signatur, mit veränderter Version oder verändertem Installer-Hash wird verworfen – auch wenn Website
  oder GitHub-Konto kompromittiert wären. Der SHA-512-Hash des Installers aus dem signierten Manifest wird nach dem
  Download verglichen; ältere Versionen werden nie angeboten.
- **Prüfsummen und SBOM:** Jedes Release enthält `SHA256SUMS.txt` (alle Dateien) und eine SBOM im CycloneDX-Format
  (`Keevault-<Version>-sbom.cdx.json`, Laufzeit-Abhängigkeiten). Die Download-Seite verlinkt beides.
- **Nachvollziehbare Builds:** Der Release-Tag im öffentlichen Repository zeigt genau auf den Quellcode, aus dem der
  Installer gebaut wurde.
- **Code-Scanning:** CodeQL (SAST, `security-extended`) bei jedem Push und wöchentlich; Dependabot für npm, GitHub
  Actions und .NET; Meldungen von Schwachstellen vertraulich über `SECURITY.md`.
- **Code-Signing:** Die Installer sind **noch nicht** mit einem öffentlich vertrauenswürdigen Zertifikat signiert
  (SmartScreen zeigt „Unbekannter Herausgeber“); das MSIX trägt ein Testzertifikat. Bis dahin: Dateien nur von
  github.com/dominguez-posh/keyvault-pwsafe-releases oder keevault.de laden und mit `SHA256SUMS.txt` vergleichen.
  Updates in der App sind davon unabhängig über das signierte Manifest geschützt.
- **Electron-Fuses:** Die installierte App ignoriert `NODE_OPTIONS` und `--inspect`, verschlüsselt Cookies und lädt
  ihren Code nur aus dem Archiv `app.asar`, dessen Hash im Programm hinterlegt ist (Windows, macOS) – ein verändertes
  Archiv startet nicht. Der Node-Modus bleibt an, weil Browser-Host und MCP-Host die App so starten.
- **Renderer-Härtung:** `contextIsolation` und `sandbox` an, kein `nodeIntegration`, strikte Content-Security-Policy,
  keine Navigation und keine neuen Fenster, als einzige Berechtigung `clipboard-sanitized-write`, externe Links nur
  über `http(s)`.
- **Netz:** Entra ID, Key Vault, Resource Manager, Graph, HIBP und Updates laufen über eine Chromium-Session nur im
  Arbeitsspeicher (`no-store`), nicht über Nodes `https`-Modul – Umgebungsvariablen wie
  `NODE_TLS_REJECT_UNAUTHORIZED` haben keine Wirkung.
- **App-PIN:** PBKDF2 mit 310.000 Runden; ab dem fünften Fehlversuch wächst die Wartezeit bis auf 15 Minuten, und der
  Zähler überlebt einen Neustart der App – auch für das Entsperren aus dem Browser.
- **Mobile-Vorschau:** Das Refresh-Token liegt nur mit einem PIN-abgeleiteten Schlüssel (PBKDF2 310.000 Runden,
  AES-GCM) in den App-Einstellungen, ohne Android-Backup; eine Bindung an Keystore/Secure Enclave folgt vor der
  Store-Veröffentlichung.

## Windows-Passkey-Anbieter

- Windows signiert jede Anfrage an den Anbieter; der Anbieter prüft die Signatur mit dem Schlüssel, den Windows bei
  der Registrierung vergeben hat (`WebAuthNPluginGetOperationSigningPublicKey`), und lehnt unsignierte Anfragen ab.
- Der Anbieter hält keine Schlüssel. Er reicht die Anfrage an die Desktop-App weiter; dort bestätigt der Benutzer
  jede Registrierung und Anmeldung, erst dann wird signiert.
- Windows erhält zur Anzeige im Auswahldialog nur Metadaten: RP-ID, Websitename, Benutzername und Benutzer-ID der
  Passkeys aus entsperrten Tresoren.
- Das Paket ist derzeit mit einem Testzertifikat signiert, dem Geräte vorher vertrauen müssen (Geräte-Skript bzw. Intune).

## Abgesicherte Datei-Tresore (Format 2)

- **Nur Passkey:** Jede Person hat zwei P-256-Schlüsselpaare (ECDH zum Empfangen des Tresor-Schlüssels, ECDSA
  zum Signieren). Die privaten Schlüssel liegen je Passkey verschlüsselt in der Datei (AES-GCM, Schlüssel aus
  WebAuthn-PRF). Es gibt kein Masterpasswort, keinen Wiederherstellungscode und keine Einladungscodes – ohne einen
  registrierten Passkey lässt sich die Datei nicht öffnen. Folge: Wer alle Passkeys verliert und keinen zweiten
  Admin hat, verliert die Daten.
- **Freigabe:** Neue Personen hinterlegen eine Anfrage (E-Mail, öffentliche Schlüssel). Ein Admin vergleicht den
  Sicherheitscode (Hash aus E-Mail und öffentlichen Schlüsseln) außerhalb der App und verpackt den Tresor-Schlüssel
  per ECDH-ES für die Person. Es wird nie ein Geheimnis übertragen.
- **Vertrauenskette:** Die Datei-ID ist ein Hash des Signaturschlüssels der Erstellerin. Rollen (Admin, Bearbeiten,
  Lesen) sind signierte Zuweisungen; gültig ist eine Zuweisung nur, wenn sie zum Zeitpunkt ihrer Erstellung von einem
  aktiven Admin signiert wurde. Die App merkt sich die ID je Datei und meldet eine ausgetauschte Datei.
- **Signierte Änderungen:** Jede Eintragsversion, Löschung und jeder Protokolleintrag trägt die Signatur der Person
  (innerhalb der Verschlüsselung). Versionen ohne gültige Signatur einer Person mit Schreibrecht zu diesem Zeitpunkt
  werden übersprungen. Leserechte sind damit auch kryptografisch durchgesetzt, obwohl alle Mitglieder den
  Tresor-Schlüssel kennen.
- **Entfernen:** Beim Entfernen einer Person wird der Tresor-Schlüssel gewechselt und alles neu verschlüsselt.
  Kopien der Datei von vor dem Entfernen bleiben für die Person lesbar.
- **Grenzen:** Wer Schreibzugriff auf den Speicherort hat, kann die Datei löschen oder Einträge unlesbar machen
  (Verfügbarkeit), aber nichts unbemerkt verändern oder lesen. Die Zeitstempel stammen von den Clients.

## Einsatzempfehlung und Reifegrad

- **Geeignet** für Team-Zugänge, Kundenzugänge und den Alltag – mit Entra-Conditional-Access, PIM für Rollen auf den
  Tresoren und aktivierten Diagnoseprotokollen.
- **Für hochprivilegierte Zugänge** (Global Admin, Domain Admin, Break-Glass, Kunden-Produktion): eigener Tresor mit
  **„Zusätzlich schützen“**, wenige Personen, eigene App-Registrierung mit strenger Conditional-Access-Regel; zusätzlich
  einen Offline-Weg für Break-Glass-Konten vorhalten (z. B. versiegelter Umschlag), damit der Zugriff nicht an
  Keevault oder Entra hängt.
- **Noch offen:** externer Penetrationstest, unabhängiges Code-Review, öffentlich vertrauenswürdiges Code-Signing,
  Schlüsselwechsel bei zusätzlich geschützten Key-Vault-Tresoren. Wir dokumentieren den Stand hier offen.
