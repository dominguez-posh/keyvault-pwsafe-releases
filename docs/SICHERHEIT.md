# Sicherheitsmodell

## Grundsatz

Keevault hat **kein Master-Passwort und keine eigene Verschlüsselungsschicht**. Vertraulichkeit und
Zugriffskontrolle kommen von Azure:

- **Entra ID** authentifiziert (MFA, Conditional Access, Anmeldehäufigkeit, konforme Geräte, phishing-resistente
  Methoden wie FIDO2 oder Windows Hello for Business).
- **Azure RBAC** entscheidet serverseitig, wer welchen Container lesen oder ändern darf. Ein manipulierter Client
  bekommt nicht mehr, als die Rolle des Benutzers erlaubt.
- **Key Vault** verschlüsselt im Ruhezustand (HSM-gestützte Schlüssel), versioniert jede Änderung und schützt
  vor dem Löschen (Soft Delete, Löschschutz).
- **Audit**: Jeder Zugriff (wer hat welches Secret wann gelesen) steht in den Key-Vault-Diagnoseprotokollen,
  wenn sie aktiviert sind (`-LogAnalyticsWorkspaceId` bzw. Bicep-Parameter).

Das ist ein bewusster Unterschied zu 1Password oder Bitwarden (Zero Knowledge): Wer in Azure die Rollen eines
Key Vaults ändern kann (Besitzer, Benutzerzugriffsadministrator, Key Vault Data Access Administrator), kann
sich selbst Zugriff geben. Empfehlungen:

- Container in ein eigenes Abonnement oder eine eigene Ressourcengruppe mit wenigen, per **PIM** zeitlich
  begrenzten Besitzern legen.
- Diagnoseprotokolle aktivieren und auf Rollenänderungen sowie ungewöhnliche Lesezugriffe alarmieren.
- Für die App eine **Conditional-Access-Richtlinie** anlegen: phishing-resistente MFA, konformes Gerät, Anmeldehäufigkeit.
- Key Vault Firewall bzw. Private Endpoint, wenn nur aus dem Firmennetz zugegriffen werden soll (die Clients
  brauchen dann Netzwerkzugang zum Vault).
- Löschschutz aktiviert lassen (Standard); er verhindert, dass ein kompromittiertes Konto Daten endgültig löscht.

## Clients

| Thema | Erweiterung | Desktop-App |
| --- | --- | --- |
| Tokens | nur im Arbeitsspeicher (`chrome.storage.session`), weg bei Browserende und Sperren | MSAL-Cache verschlüsselt mit DPAPI (`safeStorage`); Sperren verwirft das Konto im Speicher |
| Entsperren | Entra-Anmeldung; Einstellung *Konto bestätigen* (Standard), *Immer neu anmelden* oder *SSO* | dieselben drei Stufen |
| Automatisch sperren | Inaktivität (Standard 30 min), Bildschirmsperre | Inaktivität (Standard 15 min), Bildschirmsperre, Ruhezustand |
| Zwischenablage | wird nach 30 s geleert, wenn sie noch den kopierten Wert enthält | ebenso |
| Lokale Daten | keine Secrets auf der Festplatte | keine Secrets auf der Festplatte |

Ohne Master-Passwort hängt die Sperre an der Entra-Anmeldung. Auf einem entsperrten Rechner mit gültiger
Browsersitzung genügt bei *Konto bestätigen* ein Klick. Wer strenger sein will, stellt *Immer neu anmelden* ein
(per Richtlinie erzwingbar) oder setzt die Anmeldehäufigkeit per Conditional Access.

## Ausfüllen

- Treffer nur für dieselbe Domain oder eine Subdomain der gespeicherten Website, keine „ähnlichen“ Domains.
  Eine Phishing-Seite bekommt keine Vorschläge.
- Der Ursprung kommt vom Browser (`sender.origin`), nicht von der Seite. Passwörter gehen nur an Frames mit
  passendem Ursprung und erst nach einer echten Benutzeraktion.
- Das Auswahlmenü liegt in einem geschlossenen Shadow DOM der isolierten Welt; Klicks aus Seitenskripten
  (`isTrusted = false`) werden ignoriert.

## Passkeys

- Die RP-ID wird nach WebAuthn-Regeln gegen den Ursprung geprüft (gleiche Domain oder übergeordnete Domain,
  HTTPS, keine IP-Adressen). `clientDataJSON` baut die Erweiterung mit dem vom Browser gemeldeten Ursprung.
- Jede Registrierung und jede modale Anmeldung braucht eine Bestätigung im Dialog der Erweiterung
  (User Presence). Bei Conditional UI ist die Auswahl im Menü die Bestätigung.
- **User Verification (UV)** meldet die Erweiterung als erfüllt: Der Benutzer hat sich für die Sitzung bei
  Entra ID angemeldet. Websites, die UV verlangen, verlassen sich damit auf die Entra-Anmeldung und die Sperrzeit.
- Private Schlüssel liegen im Secret-Wert des Eintrags. Wer den Container lesen darf, kann den Passkey nutzen –
  so funktioniert das gemeinsame Arbeiten mit geteilten Konten. Persönliche Passkeys gehören in einen
  persönlichen Container.
- Passkeys melden „synchronisiert“ (Backup Eligible/State). Websites, die nur gerätegebundene Passkeys zulassen,
  lehnen sie ab; dann „Anderes Gerät verwenden“.

## Bekannte Restrisiken

- Titel, Benutzernamen und Websites liegen in Secret-Tags. Rollen mit Metadaten-Leserecht (z. B. *Key Vault
  Reader*) sehen sie, aber keine Passwörter. Die App vergibt solche Rollen nicht.
- Es gibt keinen Export: Die App schreibt keine Einträge in Dateien (auch nicht über die Import-Beispieldatei, die fest eingebaut ist). Sicherung und Wiederherstellung laufen auf Key-Vault-Ebene (Soft Delete, Löschschutz, Backup); Datei-Container sind selbst verschlüsselt und werden als Datei gesichert. Kopieren einzelner Werte in die Zwischenablage bleibt möglich.
- Eine kompromittierte Browsersitzung mit entsperrtem Tresor kann alle Einträge der freigegebenen Container
  lesen – wie bei jedem Passwortmanager.

## Zusätzlicher Schutz und Datei-Container

Mit zusätzlichem Schutz (Key Vault) bzw. bei Datei-Containern verschlüsselt der Client alle Einträge selbst.
Wer nur Zugriff auf den Key Vault oder die Datei hat – auch ein Azure-Administrator –, sieht nur Chiffretext.

- **Entsperrmethoden** sind gleichwertig: Masterpasswort (PBKDF2, 600 000 Runden), Passkeys mit PRF (FIDO2-
  Schlüssel, Smartphone, Windows Hello), Wiederherstellungsschlüssel (160 Bit) und befristete Einladungen.
  Ein starkes Masterpasswort ist Pflicht, wenn es genutzt wird – es schützt gegen Offline-Angriffe auf die Datei.
- **Wiederherstellungsschlüssel** sicher und getrennt aufbewahren: Ohne ihn sind die Daten verloren, wenn alle
  Passkeys und das Masterpasswort fehlen. Niemand kann sie zurückholen.
- **Einladungscodes** getrennt von der Datei weitergeben; sie gelten 7 Tage und werden nach der ersten Nutzung
  durch die eigenen Methoden der Person ersetzt.
- **Entfernen von Personen**: Der Passkey bzw. die Einladung verliert sofort die Wirkung. Wer den
  Container-Schlüssel vorher aus dem Speicher ausgelesen hat, könnte alte Kopien weiter lesen; ein Schlüsselwechsel
  ist noch nicht eingebaut. Wichtige Passwörter nach dem Ausscheiden ändern.
- **Sichtbare Metadaten**: Container-Name, Anzahl der Einträge, Zeitstempel und die Bezeichnungen der Passkeys
  (z. B. „Alex – YubiKey“) stehen unverschlüsselt in der Datei bzw. im Key Vault.
- **Wer schreiben darf, kann manipulieren**: Veränderte Einträge fallen beim Entschlüsseln auf (AES-GCM);
  unverschlüsselt eingeschleuste Einträge zeigt die App als „unverschlüsselt“ an.
- Entsperrte Container-Schlüssel liegen nur im Arbeitsspeicher (Erweiterung: `chrome.storage.session`) und werden
  beim Sperren verworfen.

## Desktop-App ↔ Erweiterung

Der Native-Messaging-Host ist nur für den eigenen Windows-Benutzer registriert und nur für die eingetragenen
Erweiterungs-IDs startbar. Die Named Pipe lässt andere Benutzer nicht schreiben. Jede Browser-Herkunft muss in
der Desktop-App einmal erlaubt werden. Gegen Schadsoftware, die als derselbe Benutzer läuft, schützt das – wie
bei jedem Passwortmanager – nicht.

## Updates und Programmintegrität

- **Signierte Update-Manifeste:** Neue Versionen erfährt die App nur über `latest.yml`, das beim Release mit einem
  Ed25519-Schlüssel signiert wird, der ausschließlich auf dem Build-Rechner liegt (`latest.yml.sig`). Ein Manifest
  ohne gültige Signatur, mit veränderter Version oder verändertem Installer-Hash wird verworfen – auch wenn Website
  oder GitHub-Konto kompromittiert wären. Der SHA-512-Hash des Installers aus dem signierten Manifest wird nach dem
  Download verglichen; ältere Versionen werden nie angeboten.
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
  Passkeys aus entsperrten Containern.
- Das Testzertifikat ist nur für eigene Tests gedacht; verteilte Pakete werden mit einem echten Code-Signing-
  Zertifikat signiert.

## Abgesicherte Datei-Container (Format 2)

- **Nur Passkey:** Jede Person hat zwei P-256-Schlüsselpaare (ECDH zum Empfangen des Container-Schlüssels, ECDSA
  zum Signieren). Die privaten Schlüssel liegen je Passkey verschlüsselt in der Datei (AES-GCM, Schlüssel aus
  WebAuthn-PRF). Es gibt kein Masterpasswort, keinen Wiederherstellungscode und keine Einladungscodes – ohne einen
  registrierten Passkey lässt sich die Datei nicht öffnen. Folge: Wer alle Passkeys verliert und keinen zweiten
  Admin hat, verliert die Daten.
- **Freigabe:** Neue Personen hinterlegen eine Anfrage (E-Mail, öffentliche Schlüssel). Ein Admin vergleicht den
  Sicherheitscode (Hash aus E-Mail und öffentlichen Schlüsseln) außerhalb der App und verpackt den Container-Schlüssel
  per ECDH-ES für die Person. Es wird nie ein Geheimnis übertragen.
- **Vertrauenskette:** Die Datei-ID ist ein Hash des Signaturschlüssels der Erstellerin. Rollen (Admin, Bearbeiten,
  Lesen) sind signierte Zuweisungen; gültig ist eine Zuweisung nur, wenn sie zum Zeitpunkt ihrer Erstellung von einem
  aktiven Admin signiert wurde. Die App merkt sich die ID je Datei und meldet eine ausgetauschte Datei.
- **Signierte Änderungen:** Jede Eintragsversion, Löschung und jeder Protokolleintrag trägt die Signatur der Person
  (innerhalb der Verschlüsselung). Versionen ohne gültige Signatur einer Person mit Schreibrecht zu diesem Zeitpunkt
  werden übersprungen. Leserechte sind damit auch kryptografisch durchgesetzt, obwohl alle Mitglieder den
  Container-Schlüssel kennen.
- **Entfernen:** Beim Entfernen einer Person wird der Container-Schlüssel gewechselt und alles neu verschlüsselt.
  Kopien der Datei von vor dem Entfernen bleiben für die Person lesbar.
- **Grenzen:** Wer Schreibzugriff auf den Speicherort hat, kann die Datei löschen oder Einträge unlesbar machen
  (Verfügbarkeit), aber nichts unbemerkt verändern oder lesen. Die Zeitstempel stammen von den Clients.

## Keine Klartext-Kopien außerhalb des Arbeitsspeichers

- Die Desktop-App schreibt keine Passwörter auf die Festplatte: Key-Vault-Einträge liegen nur im Arbeitsspeicher
  (Index und Container-Schlüssel in einem flüchtigen Speicher), Datei-Container sind verschlüsselt (auch die
  Zwischendatei beim Speichern), der Anmelde-Cache ist per DPAPI verschlüsselt, die PIN nur als Hash gespeichert.
- Die Erweiterung nutzt nur `chrome.storage.session` (Arbeitsspeicher, nicht für Inhaltsskripte zugänglich).
- Kopieren in der Desktop-App setzt die Windows-Kennzeichen `ExcludeClipboardContentFromMonitorProcessing`,
  `CanIncludeInClipboardHistory = 0` und `CanUploadToCloudClipboard = 0`: kein Zwischenablageverlauf (Win+V), keine
  Cloud-Zwischenablage. Nach der eingestellten Zeit wird die Zwischenablage geleert. Abtippen (Auto-Type) nutzt die
  Zwischenablage gar nicht. Die Browser-Erweiterung kann diese Kennzeichen nicht setzen – dort besser Ausfüllen nutzen.
- Kein Export (siehe oben). Werte an Hilfsprozesse (Abtippen, Zwischenablage) gehen nur über stdin, nie über
  Kommandozeilen (die in Protokollen landen könnten).
- Grenzen: Inhalte im Arbeitsspeicher können über die Auslagerungsdatei oder Speicherabbilder auf die Platte
  gelangen (wie bei jeder Anwendung) – gegen Angreifer mit Zugriff auf das angemeldete Benutzerkonto schützt keine
  App vollständig.
