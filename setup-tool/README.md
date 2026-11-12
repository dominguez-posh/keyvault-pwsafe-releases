# Keevault-Einrichtungstool (#501)

Richtet die Azure- und Entra-Umgebung für Keevault ein und führt den Administrator mit einer Checkliste durch.
Eigene portable App, keine Installation, kostenlos für alle Editionen. Der manuelle Weg (`infra/`) bleibt.

Stand: **Teil a** – Kern (Plan, Schritte, Probelauf, Ausführen), Rechte-Prüfung, Ressourcengruppe, Key Vault mit RBAC,
Gruppen Read/Write/Admin je Tresor mit Rollen, Tipps PIM/Notfallkonto/bedingter Zugriff, Einstellungs-Export und
-Import, grafischer Assistent. **Teil b** – Doku mit Notfallhandbuch (Markdown, HTML zum Drucken, Word), Deutsch und
Englisch (Oberfläche, Schritte, Doku), Erkennung von Entra ID P2 für PIM. **Teil c** – Terraform-Export (optional).
**Teil d** – Geräte-Richtlinien für GPO und Intune. **Teil e** – Drift-Prüfung, Prüfung gegen CIS/CISA, Updater und
portables Paket.

## Start

```powershell
Install-Module Az.Accounts -Scope CurrentUser   # einmalig, wie infra/
.\setup-tool\Keevault-Setup.ps1                 # öffnet den Assistenten in einem Edge-Fenster
```

Ohne Fenster, z. B. für wiederholte Läufe:

```powershell
Import-Module .\setup-tool\KeevaultSetup
Connect-KeevaultSetup -TenantId <tenant>
$plan = Import-KeevaultSetupPlan -Path .\keevault-einrichtung.json   # oder New-KeevaultSetupPlan -Vault kv-team-a
$dry  = Invoke-KeevaultSetup -Plan $plan -WhatIf                     # liest nur, zeigt je Schritt was fehlt
Invoke-KeevaultSetup -Plan $plan -ConfirmPlanHash $dry.PlanHash      # fragt je Änderung nach
New-KeevaultSetupReport -Result $dry -Format Html -Path .\Keevault-Einrichtung.html   # oder Markdown, Docx
Set-KeevaultSetupLanguage en                                         # Schritte und Doku auf Englisch
```

## Doku und Notfallhandbuch (Teil b)

Die Doku entsteht aus Plan und Ergebnis (`Report.ps1` baut ein Modell, `Render.ps1` gibt es als Markdown, als
eigenständiges HTML mit Druck-Layout (A4, Seitenumbruch vor dem Handbuch) oder als DOCX aus; DOCX ist von Hand
geschriebenes Office Open XML über `System.IO.Compression`, keine neue Abhängigkeit). Inhalt: Umgebung (Tenant,
Subscription, Ressourcengruppe, Gruppenmuster, Entra ID P2, Plan-Fingerabdruck), Tresore, Gruppen und Rollen,
erledigte, geplante, fehlende und manuelle Schritte, Übersprungenes, Antworten auf die Rückfragen, Hinweise und
Abweichungen von der Empfehlung. Danach das **Notfallhandbuch** (Schritt `emergencyHandbook`, abwählbar):
Notfallkonto (Ort des FIDO-Sticks, wer Zugang hat, Ablauf), Wiederherstellungsschlüssel (nur der Ort), Ausscheiden
einer Person (Gruppen des Plans, Compliance-Ansicht #500), kompromittiertes Gerät, Kontakte, Prüfliste für
Schlüsselwechsel und Passwortänderungen.

- **Rückfragen:** `breakGlassFidoLocation`, `breakGlassAccess`, `recoveryKeyLocation`, `contactOwner`,
  `contactEmergency`. Freitext, geprüft wie bisher (Ort, Name, Telefon ja; PIN, Passwort, Schlüssel, Token nein).
- **Keine Secrets:** jede Ausgabe (Markdown, HTML, DOCX) wird vorher als Text gegen dieselbe Heuristik geprüft und
  sonst verweigert. Antworten werden je Format escaped (kein Link, kein HTML, kein XML).
- **Entra ID P2:** die Rechte-Prüfung liest `subscribedSkus` (Serviceplan `AAD_PREMIUM_P2` auf einer aktiven Lizenz).
  Ohne P2 wird der PIM-Tipp zum Hinweis „benötigt Entra ID P2“, ohne Leserecht bleibt er ein Tipp mit Warnung.
- **Sprache:** `Set-KeevaultSetupLanguage de|en`; Texte der Engine in `Private/I18n.ps1`, des Fensters in
  `ui/i18n.js`. Ein Lauf merkt sich seine Sprache, die Doku folgt ihr.

## Terraform (Teil c, optional)

`ConvertTo-KeevaultSetupTerraform -Plan $plan -Path .\keevault\main.tf` bzw. „Als Terraform exportieren“ im
Assistenten erzeugt aus denselben Schritten (`Get-KeevaultSetupStep`, Rollen aus `KsLevels`, Tresor-Einstellungen aus
`KsVaultSettings`) Code für `azurerm` (~> 4.50) und `azuread` (~> 3.0): Ressourcengruppe, Key Vault mit RBAC,
Gruppen Read/Write/Admin, Rollenzuweisungen; abgewählte Schritte werden zu `data`-Quellen, manuelle Schritte zu
Kommentaren. Tenant und Subscription sind Variablen (`-var tenant_id=… -var subscription_id=…`), nie im Code; der
Text wird wie die Doku auf Geheimnisse geprüft. Vom Tool schon angelegte Zuweisungen mit `terraform import`
übernehmen. Test: `terraform validate` auf zwei Varianten, wenn `terraform` installiert ist (sonst übersprungen mit
Grund; Provider-Cache im Temp-Ordner).

## Geräte-Richtlinien: GPO und Intune (Teil d)

Der Admin wählt im Assistenten (Block „Geräte-Richtlinien“) bzw. im Plan unter `devicePolicy`, was vorgegeben wird;
nicht Gewähltes bleibt beim Benutzer. Felder: `scope` (`machine`/`user`), `requirePin`, `updateChannel`
(`stable`/`beta`), `updateMode`, `browserIntegration` (Native-Messaging-Registrierung), `windowsProvider`
(Windows-Passkey-Anbieter), `tenantId`, `clientId`, `connectVaults` (Tresore des Plans verbinden),
`extensionBrowsers` (`edge`, `chrome`: Erweiterung erzwingen) und `extensionSource` (`github`; `store` für die
Edge-Add-ons-Einträge aus #483 ist vorbereitet und wird abgelehnt, solange ihre IDs fehlen). Schalter sind
`true`/`false`/`null` (= nicht vorgeben). Pläne ohne `devicePolicy` bleiben gültig; „portabel“ lässt Tenant- und
Client-ID weg.

`Export-KeevaultSetupDevicePolicy -Plan $plan -Path .\Richtlinien` bzw. „Richtlinien-Paket herunterladen (ZIP)“:

| Datei | Inhalt |
| --- | --- |
| `GPO/PolicyDefinitions/` | `Keevault.admx` mit `de-DE`/`en-US` (dieselben Dateien wie `Keevault-Richtlinien.zip`, Quelle `installer/policy`) |
| `GPO/New-KeevaultGpo.ps1` | legt ein eigenes GPO mit den Werten an. Ohne `-Apply` nur Probelauf (liest, zeigt, ändert nichts); mit `-Apply` fragt PowerShell nach (ConfirmImpact High), `-WhatIf` schreibt nie. Bricht ab bei einem fremden GPO gleichen Namens (Kennzeichen im Kommentar) oder wenn ein anderes GPO (Registry oder Einstellungen/GPP) schon den Forcelist-Eintrag des Browsers setzt. Setzt nur die Forcelist, nie `ExtensionSettings` (würde eine Sperrliste der Firma ersetzen); Intune, Chrome Browser Cloud Management und lokale Richtlinien sieht es nicht. Ein erneuter Lauf entfernt nur die eigenen Werte (nach Name bzw. Inhalt), nie einen ganzen Schlüssel. Verknüpft nicht. |
| `Intune/Keevault-Richtlinien.intune.json` | Profil `windows10CustomConfiguration`: ADMX-Ingestion plus je Wert eine OMA-URI (`Keevault~Policy~Keevault/<Richtlinie>`). Alternativ ADMX unter „Importierte administrative Vorlagen“. |
| `Intune/Keevault-Browser-Erkennung.ps1`, `Keevault-Browser-Richtlinie.ps1` | Korrektur (Erkennung/Behebung) für Forcelist und ExtensionSettings in HKLM, feste Werte wie `desktop/machine-setup.js`; fremde Einträge bleiben, setzt `NoExtensionPolicy`, damit App und `Keevault-Geraet-Einrichten.ps1` keine eigene Richtlinie anlegen. |
| `Anleitung.md` / `Instructions.md` | gewählte Werte, Schritte für GPO, Intune und App-Verteilung (MSI mit `KV_NO_POLICY=1`, Win32) |

Die Browser-Werte gehen nicht über ADMX-Ingestion, weil Intune damit nicht unter `Software\Policies\Microsoft`
schreiben darf. Optional legt `Publish-KeevaultSetupIntuneProfile` das Profil per Graph an, nur wenn das Token es darf
(sonst Hinweis auf die Datei), nur neu und nie über ein vorhandenes Profil gleichen Namens. Jede erzeugte
Konfiguration wird auf Geheimnisse geprüft; die Doku (Teil b) bekommt einen Abschnitt mit den gewählten Werten und
Abhakpunkten. Das portable Paket (Teil e) bringt `installer/policy` als `setup-tool/policy` mit.

## Drift, CIS/CISA, Updater (Teil e)

Alles hier liest nur; nichts davon schreibt in Tenant oder Gerät.

- **Drift** (`Test-KeevaultSetupDrift -Plan $plan [-Device] [-NoTenant]`, Assistent Abschnitt 5): Plan aus der Auswahl
  oder dem Einstellungs-Export gegen den Ist-Stand. Tenant: Ressourcengruppe, Tresore (RBAC, Soft-Delete-Tage,
  Purge-Schutz, Markierung `kvpwsafe=container`, Region), Gruppen (vorhanden, eindeutig, Sicherheitsgruppe),
  Rollenzuweisungen des Plans und zusätzliche Zuweisungen am Tresor (z. B. Freigaben aus der App, Rollen über der Stufe).
  Gerät (`-Device`): die Registry-Werte aus `devicePolicy` (wie Teil d) auf diesem Rechner. Status: wie geplant, fehlt,
  weicht ab, zusätzlich, nicht geprüft (fehlendes Leserecht ist nie „fehlt“). **Korrekturangebot:** Fehlendes legt der
  normale Lauf an (Knopf führt zum Probelauf); Abweichendes und Zusätzliches bekommt einen Hinweis und bleibt, weil das
  Tool Fremdes nie ändert. Leser-Rechte genügen.
- **Sicherheitsempfehlungen** (`Test-KeevaultSetupCompliance -Plan $plan`): Katalog als versionierte Daten in
  `KeevaultSetup/Data/controls.json`. **Entscheidung Lucas (11.11.2026): CISA voll, CIS als Hinweis.** Jede Prüfung ist
  von Keevault formuliert. CISA SCuBA Entra ID wird voll genutzt (phishing-resistente MFA, ältere Authentifizierung,
  Benutzerzustimmung, 2 bis 8 globale Admins, PIM manuell): „geprüft gegen Kontrolle MS.AAD.x“. Die Tresor-Prüfungen
  (RBAC, wiederherstellbar, Protokollierung AuditEvent, private Endpunkte, Ablaufdatum) sind „Keevault-Empfehlung“.
  CIS-Nummern stehen nur als „ungeprüfte Zuordnung“ dabei (Feld `cis`, Rahmenwerk `unverified`), ohne CIS-Texte; der
  Bericht sagt das. Abgleich mit den CIS-Fassungen erst nach Klärung der Nutzungsbedingungen. Ergebnis je Zeile:
  erfüllt, nicht erfüllt, begründete Abweichung (private Endpunkte und Ablaufdatum, Begründung dabei), manuell, nicht
  geprüft (z. B. ohne Leserecht für bedingten Zugriff). Nie „konform“.
- **Bericht:** `New-KeevaultSetupCheckReport -Drift $d -Compliance $c -Format Markdown|Html|Docx` (gleiche Ausgabe und
  Geheimnis-Prüfung wie die Doku aus Teil b).
- **Paket:** `node scripts/pack-setup-tool.mjs` → `release/Keevault-Einrichtungstool-<version>.zip` mit `setup-tool/`
  (nur versionierte Dateien per `git ls-files`, ohne `tests/`), `setup-tool/policy/` (= `installer/policy`), `setup-tool/version.json`, den Update-Schlüsseln der App
  und `extension/styles/app.css`. `release.mjs` baut es mit und lädt es als Release-Datei hoch.
- **Updater** (`Get-KeevaultSetupUpdate`, `Install-KeevaultSetupUpdate`, Assistent Abschnitt 6): dieselbe Prüfung wie
  die App: `latest.yml` muss gegen die eingebetteten Schlüssel verifizieren (`Data/update-keys.json` = `UPDATE_KEYS`
  aus `desktop/update-verify.js`; Ed25519 nach RFC 8032 in PowerShell, Hardware-Schlüssel als WebAuthn-Assertion
  über P-256), `SHA256SUMS.txt` muss `kvSha256Sums` treffen, das ZIP seine Zeile darin. Nur neuere Versionen. Entpackt
  wird in einen neuen Ordner `Keevault-Einrichtungstool-<version>` neben dem alten (erst in einen temporären Ordner,
  geprüft: Pfade nur unter `setup-tool/` und `extension/styles/`, keine `..`, Größen- und Anzahlgrenze, Version
  stimmt), dann umbenannt; das laufende Tool bleibt unverändert. Aus dem Quellcode gestartet gibt es kein Update.

## Aufbau

| Teil | Ort | Aufgabe |
| --- | --- | --- |
| Modul `KeevaultSetup` | `KeevaultSetup/` | Kern; `Private/<thema>.ps1`: I18n (Texte), Rest (Transport), Plan, Rights, Steps, Report (Doku-Modell), Render (Markdown/HTML/DOCX), Terraform, DevicePolicy/DeviceExport (Teil d), Server; `Templates/` erzeugte Skripte |
| Assistent | `ui/` | HTML/JS im Keevault-Design (`extension/styles/app.css` + `setup.css`), ruft das Modul über den lokalen Server |
| Start | `Keevault-Setup.ps1` | lädt das Modul und öffnet den Assistenten |
| Beispiel | `examples/plan.example.json` | Plan mit Platzhaltern |
| Tests | `tests/` + `test/setup-tool-501.test.js`, `test/setup-tool-501e.test.js` (Updater) | Attrappe für ARM und Graph, Szenarien in PowerShell 5.1 und 7, Server |

- **Nur Az.Accounts:** alle Anfragen über `Invoke-AzRestMethod` (ARM und Microsoft Graph mit demselben Konto), ein
  einziger Transport (`Invoke-KsRest`), den Tests und Attrappe ersetzen.
- **Status je Schritt:** erledigt, übersprungen, manuell, Hinweis, fehlt Recht; dazu im Probelauf „wird angelegt“
  sowie „fehlgeschlagen“ und „wartet auf vorherigen Schritt“.
- **Idempotent:** Vorhandenes bleibt, Rollenzuweisungen haben einen festen Namen je Bereich, Gruppe und Rolle.
- **Nichts ohne Probelauf und Bestätigung:** Ausführen verlangt den Fingerabdruck des Plans aus dem Probelauf;
  in der Konsole fragt PowerShell je Änderung nach (ConfirmImpact High), im Assistenten der Knopf „Ausführen“.
- **Fremdes bleibt unberührt:** das Tool legt nur an; es löscht und ändert keine Rollenzuweisungen, Gruppen,
  Richtlinien oder Tresore. Ein Tresor mit Zugriffsrichtlinien wird nicht auf RBAC umgestellt (manueller Schritt).
- **Keine Secrets:** der Plan hat kein Feld dafür, Antworten auf Rückfragen werden geprüft (Ort ja, PIN oder
  Schlüssel nein), die fertige Doku noch einmal. Die Doku enthält Tenant-Daten und gehört dem Kunden.
- **Export/Import:** JSON, streng geprüft (unbekannte Felder, Typen, Namen, Größe). `-Portable` bzw. die Auswahl im
  Assistenten lässt Tenant, Subscription und Antworten weg, für einen anderen Tenant.

## Technik des Assistenten

PowerShell-Modul + lokaler `HttpListener` auf `localhost` + Edge im App-Modus (`msedge --app`, eigenes temporäres
Profil). Alles davon ist auf Windows 10/11 vorhanden: keine DLLs (WebView2-SDK), kein Electron-Paket (~100 MB mit
eigenem Update-Weg), dieselben CSS-Tokens wie die App. Das Modul bleibt ohne Fenster nutzbar (Automatisierung,
Teil c bis e). Schutz des Servers: einmaliger Startlink mit Zufallstoken, danach HttpOnly-/SameSite-Strict-Cookie,
API nur per POST mit eigener Kopfzeile, Host muss `localhost:<port>` sein, feste Dateiliste, CSP ohne Inline-Skripte.

Updater und Paket: siehe Teil e. Authenticode-Signatur der Skripte folgt mit 1.0; bis dahin startet das Tool mit
`powershell -ExecutionPolicy Bypass -File .\setup-tool\Keevault-Setup.ps1` (ein aus dem Browser geladenes ZIP vorher mit
`Unblock-File` bzw. Eigenschaften → Zulassen entsperren).

## Tests

`npm test` (enthält `test/setup-tool-501.test.js`, nur Windows) und `npm run check` (prüft auch die PowerShell-Syntax,
UTF-8-BOM für Windows PowerShell 5.1 und die exportierten Funktionen). Getestet nur gegen die Attrappe; ein echter
Tenant steht aus.
