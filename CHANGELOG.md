# Changelog

Ein Abschnitt pro Version, Deutsch zuerst, die englische Liste unter `### English`. `scripts/release-notes.mjs` hängt den
Abschnitt der aktuellen Version als `releaseNotes` an `release/latest.yml` (wird mitsigniert) und nutzt ihn als Text des
GitHub-Releases; die App zeigt ihn im Update-Dialog. Ohne Abschnitt für die Version bricht das Release ab.

## 0.9.4 – 2026-11-01
- Geräte: Verknüpfte Konten (RDP, TeamViewer, Bastion) werden in einem Fenster mit Suche ausgewählt statt in einer langen Liste.
- Geräte: Verknüpfen geht nur noch mit Einträgen im selben Tresor; die App lehnt Verweise in andere Tresore beim Speichern und Verbinden ab.
- Kopieren: Keevault prüft selbst (eigenes Hilfsprogramm), ob der Text in der Zwischenablage angekommen ist – auf manchen Rechnern meldete die App sonst „Die Zwischenablage ist nicht verfügbar“, obwohl das Kopieren geklappt hatte. Auch das automatische Leeren nach der eingestellten Zeit funktioniert dort jetzt.
- Mehrere persönliche Tresore (z. B. privat und geschäftlich): „+“ → „Weiterer persönlicher Tresor“, eigener Name und eigene Datei; Einträge lassen sich zwischen persönlichen Tresoren frei verschieben, die App-PIN entsperrt alle.
- Admin-Modus: Unten in der Seitenleiste schaltet „Passwörter | Geräte“ zwischen Einträgen und Geräten um (statt eines Reiters); bei Geräten zeigt die Liste oben „Geräte“ und das Suchfeld „Geräte suchen“.
- Tresor-Suche: Lupe in der Überschrift „Tresore“, das Suchfeld öffnet sich beim Darüberfahren (oder Klick), Esc leert es – bei jeder Anzahl Tresore.
- Admin-Modus ein/aus wirkt sofort auf Liste (Reiter „Geräte“) und geöffneten Eintrag.
- Geräte: Ein Menüpunkt „Neue VM / neuer Server“, der Typ wird im Eintrag gewählt – Windows-Server (RDP), Linux-Server (SSH), Azure-VM (Bastion), VMware-VM (vSphere-Client), Hyper-V-VM (Windows Admin Center) oder sonstiges Gerät; VMs mit Windows oder Linux. SSH öffnet ein Terminal, das Passwort liegt in der Zwischenablage.

### English
- Devices: linked accounts (RDP, TeamViewer, Bastion) are picked in a window with search instead of a long list.
- Devices: links only to entries in the same vault; the app refuses links into other vaults when saving and connecting.
- Copy: Keevault checks with its own helper that the text arrived on the clipboard – on some machines the app reported "The clipboard is not available" although copying had worked. Clearing after the set time works there now too.
- Several personal vaults (e.g. private and business): "+" → "Another personal vault", own name and file; entries move freely between personal vaults, the app PIN unlocks all of them.
- Admin mode: "Passwords | Devices" at the bottom of the sidebar switches between entries and devices (instead of a tab); with devices the list head shows "Devices" and the search says "Search devices".
- Vault search: magnifier in the "Vaults" header, the field opens on hover (or click), Esc clears it – with any number of vaults.
- Switching admin mode updates the list ("Devices" tab) and the open entry at once.
- Devices: one menu item "New VM / server", the kind is chosen in the entry – Windows server (RDP), Linux server (SSH), Azure VM (Bastion), VMware VM (vSphere client), Hyper-V VM (Windows Admin Center) or other device; VMs run Windows or Linux. SSH opens a terminal, the password is on the clipboard.

## 0.9.3 – 2026-11-01
- Kleines Fenster: Das Hauptmenü endet am Fensterrand und lässt sich scrollen statt abgeschnitten zu werden; zu lange Kontextmenüs ebenso.

### English
- Small window: the main menu ends at the window edge and scrolls instead of being cut off; overlong context menus too.

## 0.9.2 – 2026-11-01
- Auto-Type funktioniert wieder auf Geräten mit App Control / WDAC: PowerShell läuft dort im eingeschränkten Sprachmodus, Keevault tippt jetzt über sein eigenes Hilfsprogramm. Ein Zielfenster, das als Administrator läuft, wird gemeldet statt still zu scheitern.
- Kopieren: Kein „Die Zwischenablage ist nicht verfügbar“ mehr, wenn ein anderes Programm (Zwischenablage-Verlauf, Virenschutz) die Zwischenablage kurz festhält.
- Passkey speichern: „Speichern in“ bietet auch Einträge mit demselben Benutzernamen an und wählt ihn vor – z. B. das Microsoft-Konto, auch wenn dort keine login.microsoft.com-Adresse hinterlegt ist.
- Neu → „Neuer Microsoft-Login“ und „Neuer Active-Directory-Logon“: Vorlagen mit Microsoft-Logo, den Anmeldeadressen (login.microsoftonline.com, login.microsoft.com, Azure-Portal, Admin Center) bzw. den Feldern Domäne (NetBIOS/DNS) und Domänencontroller.
- Mit eingeschalteten Admin-Werkzeugen zeigt ein Microsoft-Eintrag „Admin Center öffnen …“ – das Konto ist dort schon ausgewählt.
- Die optionale Leiste unten im Eintrag entfällt; alle Aktionen liegen im „⋯“ neben dem Titel.
- Admin-Modus: oben rechts dezent „Admin-Modus“ statt der Knöpfe PIM, M365 und Server. PIM und alle Admin Center liegen als Kacheln im Microsoft-Eintrag – ein Klick öffnet sie und meldet mit diesem Konto an.
- Geräte: Server-Einträge heißen jetzt Geräte (Server, Azure-VM, sonstiges Gerät) und stehen in einem eigenen Reiter „Geräte“, nur im Admin-Modus. Nur dort lassen sie sich anlegen („Neuer Server“, „Neue Azure-VM (Bastion)“).
- Passkey verschieben: Ein Passkey im falschen Eintrag lässt sich mit dem Pfeil-Symbol in einen anderen Login-Eintrag verschieben (auch in einen anderen Tresor). Er wird erst im Ziel gespeichert und dann im alten Eintrag entfernt.
- Browser-Erweiterung: Die Leiste „Mit Keevault anmelden“ hat bei mehr als drei Microsoft-Konten ein Suchfeld (Titel, Benutzer, Tresor; Enter nimmt den ersten Treffer).
- Sicherheit: Microsoft- und Bastion-Anmeldedaten gibt die Erweiterung nur noch an https-Seiten auf dem Standard-Port – nicht an eine gleichnamige Seite über http oder einen anderen Port.

### English
- Auto-type works again on devices with App Control / WDAC (PowerShell in Constrained Language Mode): Keevault types through its own helper. A target window running as administrator is reported instead of failing silently.
- Copy: no more "The clipboard is not available" when another program briefly holds the clipboard.
- Saving a passkey: "Save in" also offers entries with the same user name and preselects it.
- New → "New Microsoft login" and "New Active Directory logon": templates with the Microsoft logo and the sign-in addresses, or the domain and domain controller fields.
- With admin tools on, a Microsoft entry shows "Open admin center …" with that account preselected.
- The optional bar at the bottom of an entry is gone; every action is in the "⋯" beside the title.
- Admin mode: a quiet "Admin mode" note at the top right instead of the PIM, M365 and Server buttons. PIM and every admin center are tiles in the Microsoft entry – one click opens it, signed in with that account.
- Devices: server entries are now devices (server, Azure VM, other device) in their own "Devices" tab, only in admin mode, and can only be created there.
- Move a passkey: a passkey saved in the wrong entry moves to another login (also in another vault) with the arrow icon – saved in the target first, then removed from the old entry.
- Browser extension: the "Sign in with Keevault" bar gets a search field with more than three Microsoft accounts (title, user, vault; Enter takes the first hit).
- Security: the extension hands Microsoft and Bastion sign-in data only to https pages on the standard port – not to a page of the same name over http or another port.

## 0.9.1 – 2026-11-01
- Microsoft-Anmeldung mit einem Klick: Auf der Microsoft-Anmeldeseite bietet die Browser-Erweiterung „Mit Keevault anmelden“ mit deinen Microsoft-Konten an und trägt Konto, Passwort und Einmalcode selbst ein. Mit „Merken und künftig automatisch anmelden“ startet die Anmeldung beim nächsten Mal von selbst (kurzer Countdown, „Anderes Konto“ zum Wechseln).
- Nur noch **ein** Eintrag unter Einstellungen → Apps: Der Windows-Passkey-Anbieter ist jetzt Teil der Keevault-Installation (Paket mit externem Speicherort) statt einer eigenen App „Keevault Passkeys“. Das Update stellt automatisch um; danach Keevault einmal unter Einstellungen → Konten → Passkeys → Erweiterte Optionen wieder einschalten – die App erinnert daran.
- Der Passkey-Anbieter wird nur noch eingerichtet, wenn du ihn in den Einstellungen einschaltest, und beim Ausschalten wieder entfernt. Für Edge und Chrome ist er nicht nötig, dort nutzt die Browser-Erweiterung die Passkeys direkt. Wo er schon eingerichtet ist, bleibt er an.
- Zwei Installationen auf einem Gerät (MSI für alle Benutzer und EXE nur für dich) erkennt Keevault jetzt und sagt es: Beide stehen im Startmenü als „Keevault“, nur eine aktualisiert sich – bisher startete man so leicht eine alte Version. Der Hinweis zeigt Version und Ort und öffnet auf Wunsch Einstellungen → Apps.
- Das Setup prüft schon vor der Installation, ob noch eine ältere Keevault-Installation für alle Benutzer da ist, und bietet an, sie zuerst zu entfernen („Entfernen & installieren“, mit der Windows-Abfrage für Administratorrechte).

### English
- Microsoft sign-in in one click: on the Microsoft sign-in page the browser extension offers “Sign in with Keevault” with your Microsoft accounts and enters account, password and one-time code itself. With “Remember and sign in automatically from now on” the sign-in starts by itself next time (short countdown, “Other account” to switch).
- Only **one** entry under Settings → Apps: the Windows passkey provider is now part of the Keevault installation (package with external location) instead of a separate app “Keevault Passkeys”. The update switches over automatically; afterwards switch Keevault on once more under Settings → Accounts → Passkeys → Advanced options – the app reminds you.
- The passkey provider is now only set up when you turn it on in the settings, and removed again when you turn it off. Edge and Chrome do not need it, there the browser extension uses the passkeys directly. Where it is already set up, it stays on.
- Two installations on one device (MSI for all users and EXE just for you) are now detected and pointed out: both appear as “Keevault” in the Start menu and only one updates itself – so far it was easy to start an old version. The notice shows version and location and opens Settings → Apps on request.
- Setup checks before installing whether an older Keevault installation for all users is still there and offers to remove it first (“Remove & install”, with the Windows prompt for administrator rights).

## 0.9.0 – 2026-11-01
- Notfallzugang beim Anlegen eines Tresors: Break-Glass-Konten bekommen direkt dauerhaft „Verwalten“; Keevault merkt sie sich je Tenant für weitere Tresore und warnt, wenn keines eingetragen ist.
- „Neu“-Menü und Rechtsklick sagen jetzt, was entsteht: „Neues Passwort / Login“, „Neue sichere Notiz“, „Neue Kreditkarte“, „Neues Zertifikat“, „Neuer Server / Ressource“.
- Website: Notfall-Export-Skript (alle Einträge ohne Keevault direkt aus Azure, für KeePass, Bitwarden & Co.) mit Anleitung und Textbaustein für den Notfallplan; neuer Artikel „Tresore absichern“ (Break-Glass-Konten, Conditional Access, Private Endpoint).
- Neu: Admin-Werkzeuge (Menü → Ansicht → Admin-Werkzeuge) – drei Knöpfe oben rechts: **PIM**, **M365** und **Server**.
- M365: Konto und Admin Center wählen (Microsoft 365, Entra ID, Intune, Defender, Purview, Exchange, Teams, SharePoint, Azure Portal) – der Browser öffnet es, die Browser-Erweiterung meldet dich an (Konto, Passwort, Einmalcode). Login-Einträge lassen sich als „Microsoft-Admin-Konto“ markieren.
- Neuer Eintragstyp **Server / Ressource**: Adresse und Port, RDP-Konto, TeamViewer-ID und -Passwort, Bastion-Link mit Microsoft-Konto und Server-Konto – jeweils als eigenes Passwort oder als Verknüpfung zu einem anderen Eintrag (z. B. dem Domänen-Admin). Verbinden mit einem Klick: Remotedesktop meldet sich selbst an, TeamViewer startet mit ID und Passwort, Bastion öffnet sich im Browser mit Anmeldung.
- Der Knopf „Server“ listet alle Server mit Suche und Verbindungsknöpfen.

### English
- Emergency access when creating a vault: break-glass accounts get “Manage” permanently right away; Keevault remembers them per tenant for further vaults and warns when none is set.
- The “New” menu and right-click now say what is created: “New password / login”, “New secure note”, “New credit card”, “New certificate”, “New server / resource”.
- Website: emergency export script (all entries without Keevault straight from Azure, for KeePass, Bitwarden & co.) with instructions and a text block for the emergency plan; new article “Hardening vaults” (break-glass accounts, Conditional Access, private endpoint).
- New: admin tools (menu → View → Admin tools) – three buttons at the top right: **PIM**, **M365** and **Server**.
- M365: choose account and admin center (Microsoft 365, Entra ID, Intune, Defender, Purview, Exchange, Teams, SharePoint, Azure portal) – the browser opens it and the browser extension signs you in (account, password, one-time code). Login entries can be marked as “Microsoft admin account”.
- New entry type **Server / resource**: address and port, RDP account, TeamViewer ID and password, Bastion link with Microsoft account and server account – each as an own password or as a link to another entry (e.g. the domain admin). Connect in one click: remote desktop signs in by itself, TeamViewer starts with ID and password, Bastion opens in the browser with sign-in.
- The “Server” button lists all servers with search and connect buttons.

## 0.8.9 – 2026-11-01
- Hell oder dunkel nach Wunsch: Menü → Ansicht → Design (System, Hell, Dunkel). „System“ folgt wie bisher dem Windows-App-Modus.
- „Neu“ sitzt jetzt oben rechts in der Liste, als ruhige Kapsel im Stil der Werkzeugleiste: Klick legt einen Login an, der Pfeil daneben bietet Notiz, Kreditkarte, Zertifikat und Ordner.
- Transparenz „Leicht“ ist dezenter: das Fenster ist zu 95 % deckend statt 90 %.
- Robustere Updates: Das Update-Fenster wartet auf alle Keevault-Prozesse (App, Browser-Anbindung, Passkey-Anbieter), bevor es die neue Version installiert, und versucht es bei „Dateien noch geöffnet“ einmal selbst erneut. Jeder Schritt landet in einem kurzen Protokoll (`%LOCALAPPDATA%\keyvault-pwsafe-updater\update.log`).
- Klare Fehlermeldungen bei Installation und Update: jeder Fehler mit Code (KV-S…, KV-U…), Erklärung, „Erneut versuchen“ und dem Link „Hilfe zu diesem Fehler“ in den neuen Wissensartikel „Installation und Updates“. Nach einem fehlgeschlagenen Update startet die bisherige Version erst beim Schließen des Fensters.

### English
- Light or dark as you like: menu → View → Theme (System, Light, Dark). “System” follows Windows’ app mode as before.
- “New” now sits at the top right of the list, as a quiet capsule in the style of the entry toolbar: a click creates a login, the arrow beside it offers note, credit card, certificate and folder.
- Transparency “Light” is subtler: the window is 95 % opaque instead of 90 %.
- More robust updates: the update window waits for every Keevault process (app, browser connection, passkey provider) before installing the new version and retries once by itself on “files still open”. Every step goes into a short log (`%LOCALAPPDATA%\keyvault-pwsafe-updater\update.log`).
- Clear messages for installation and update errors: every error with a code (KV-S…, KV-U…), an explanation, “Try again” and the link “Help for this error” into the new knowledge base article “Installation and updates”. After a failed update the previous version starts once the window is closed.

## 0.8.8 – 2026-10-31
- Rechtsklick auf die freie Fläche der Liste: neuen Eintrag oder (Unter-)Ordner anlegen, den aktuellen Ordner umbenennen oder löschen, eine Ebene nach oben, alle auswählen, aktualisieren und die Tresor-Funktionen.
- Einträge per Drag & Drop in einen anderen Tresor schieben: auf den Tresor in der Seitenleiste ziehen (auch mehrere markierte) oder einen ganzen Ordner mit Unterordnern, kurz bestätigen. Ein Ordner landet im Ziel unter seinem Namen auf oberster Ebene („Kunden/Contoso“ → „Contoso“). Ein Tresor nimmt nur an, wenn du dort schreiben darfst; aus geteilten Tresoren nicht in den persönlichen.

### English
- Right-click on the empty list area: create an entry or (sub)folder, rename or delete the current folder, go up one level, select all, refresh and the vault functions.
- Drag entries into another vault: drop them on the vault in the sidebar (several selected ones too) or a whole folder with its subfolders, and confirm. A folder lands at the top level of the target under its own name (“Kunden/Contoso” → “Contoso”). A vault only accepts them when you may write there; nothing from shared vaults into the personal one.

## 0.8.7 – 2026-10-31
- Optionaler „PIM“-Knopf oben rechts (Menü → Ansicht → PIM-Button): öffnet aka.ms/pim, um eine berechtigte Azure-Rolle mit Privileged Identity Management zu aktivieren.

### English
- Optional “PIM” button top right (menu → View → PIM button): opens aka.ms/pim to activate an eligible Azure role with Privileged Identity Management.

## 0.8.6 – 2026-10-31
- Tresor-Überschrift aufgeräumt: Ein Symbol vor dem Namen zeigt deine Berechtigung – Auge (nur lesen), Stift (bearbeiten), Schild (verwalten), Krone (Besitzer, darf Berechtigungen vergeben); beim Darüberfahren steht sie ausgeschrieben. Demo- oder Test-Lizenz stehen rechts neben dem Namen.
- Neu: persönlicher Tresor – kostenlos, nur für dich und nicht teilbar. Ein Assistent richtet ihn in wenigen Schritten ein: Speicherort (OneDrive, iCloud, Dropbox oder ein Netzlaufwerk – nie lokal), Masterpasswort mit Wiederherstellungsschlüssel, optional ein FIDO-Stick. Im Alltag entsperrt deine eine App-PIN App und persönlichen Tresor zugleich. Er steht oben in der Seitenleiste mit Person- und Anbieter-Symbol; Keevault zeigt, ob die Datei synchronisiert ist. Einträge aus geteilten Tresoren lassen sich nicht hineinschieben, aus dem persönlichen in geteilte schon.
- Unten links neben „Hilfe“ steht die Organisation, mit der du bei Microsoft angemeldet bist.
- Transparenz „Leicht“ ist jetzt Standard (auch nach „Ansicht auf Standard“).
- Website: Die Live-Demo zeigt einen dezenten Glas-Effekt – ein Farbverlauf schimmert durch den Grund, die Karten bleiben deckend.

### English
- Tidier vault heading: a symbol before the name shows your permission – eye (read only), pen (edit), shield (manage), crown (owner, may grant permissions); hovering spells it out. Demo or trial license sit right of the name.
- New: personal vault – free, just for you and not shareable. A wizard sets it up in a few steps: location (OneDrive, iCloud, Dropbox or a network drive – never local), master password with recovery key, optionally a FIDO key. Day to day your one app PIN unlocks the app and the personal vault together. It sits at the top of the sidebar with a person and a provider mark; Keevault shows whether the file is in sync. Entries from shared vaults cannot be moved in, from the personal vault to shared ones they can.
- Bottom left next to “Help” shows the organisation you are signed in to Microsoft with.
- Transparency “Light” is now the default (also after “Reset view”).
- Website: the live demo shows a subtle glass effect – a colour gradient shines through the ground, the cards stay opaque.

## 0.8.5 – 2026-10-31
- Eintrag aufgeräumt: eine schlanke Werkzeugleiste, die unten mittig über dem Eintrag schwebt (bleibt beim Scrollen sichtbar) – Stern (Favorit), „Link kopieren“, „Bearbeiten“ als ruhiger Text-Knopf und „⋯“ mit allem Weiteren (Verschieben, Duplizieren, Verlauf, Löschen) – keine Knopfwand mehr unter den Feldern. Dazu ein ausgegrautes „⋯“ neben dem Titel, das beim Darüberfahren alle Aktionen zeigt; die Leiste unten lässt sich unter Menü → Ansicht ausblenden.
- Neuer Eintrag: Wechselst du links Tresor oder Ordner, während der neue Eintrag offen ist, übernimmt das Formular beides – Eingetipptes bleibt.
- Tresore zeigen ihren Speicherort: ein blaues „A“ für Azure Key Vault, eine Festplatte für lokale Datei-Tresore (Menü → Ansicht → Speicherort).
- Leere Detailansicht mit dem Keevault-Zeichen (Schild mit Schlüsselloch) als stiller Umriss.
- Fensterknöpfe oben rechts werden mit abgedunkelt, solange ein Dialog offen ist.
- Spaltenaufteilung: Die Liste ist standardmäßig die breiteste Spalte (55 % neben der Seitenleiste), die Seitenleiste etwas breiter (280 px); „Ansicht auf Standard“ im Menü setzt Zoom, Transparenz, Leisten, Symbole und Spaltenbreiten zurück.

### English
- Tidier entry: one slim toolbar floating at the bottom centre of the entry (stays visible while scrolling) – star (favorite), “Copy link”, “Edit” as a quiet text button and “⋯” with everything else (move, duplicate, history, delete) – no wall of buttons below the fields. Plus a quiet “⋯” beside the title that shows every action on hover; the bottom bar can be hidden under menu → View.
- New entry: picking another vault or folder on the left while a new entry is open puts both into the form – what you typed stays.
- Vaults show where they live: a blue “A” for Azure Key Vault, a drive for local file vaults (menu → View → Storage).
- Empty detail pane with the Keevault mark (shield with keyhole) as a quiet outline.
- Window buttons top right are dimmed along while a dialog is open.
- Column split: the list is the widest column by default (55 % beside the sidebar), the sidebar a little wider (280 px); “Reset view” in the menu resets zoom, transparency, bars, marks and column widths.

## 0.8.4 – 2026-10-31
- Papierkorb wieder da (Rechtsklick auf den Tresor → Papierkorb): gelöschte Einträge mit Löschdatum und Frist, Wiederherstellen mit einem Klick, endgültig löschen nur wenn die Tresor-Einstellungen es erlauben. Der Löschdialog verweist darauf.
- Website: Wissensartikel „Den Key Vault richtig betreiben“ (Aufbewahrung, Löschschutz, Wiederherstellung, Backups, Rollen, Protokolle, Netzwerk, Checkliste).
- Gelöschte Einträge tauchen beim Aktualisieren nicht mehr kurz wieder auf: Eigene Änderungen schreiben den Schnell-Index nach 1,5 s statt nach bis zu 20 s, und Aktualisieren schreibt ausstehende Änderungen vor dem Laden.

### English
- Trash is back (right-click the vault → Trash): deleted entries with deletion date and period, restore with one click, delete for good only if the vault settings allow it. The delete dialog points to it.
- Website: article “Running the Key Vault well” (retention, purge protection, recovery, backups, roles, logs, network, checklist).
- Deleted entries no longer reappear briefly when refreshing: own changes write the fast index after 1.5 s instead of up to 20 s, and refreshing writes pending changes before loading.

## 0.8.3 – 2026-10-31
- Sicherheit nachgeschärft (Review-Findings): Kopieren setzt die Kennzeichen gegen Zwischenablage-Verlauf und Cloud-Zwischenablage jetzt auch, wenn der PowerShell-Hilfsprozess blockiert ist (eigenes Hilfsprogramm); Absturzabbilder abgeschaltet, alte gelöscht, Keevault von der Windows-Fehlerberichterstattung ausgenommen; Tresor-Infos zeigen, welche Metadaten ohne Zusatzschutz im Klartext lesbar sind.
- Schmale Azure-Rollen „Keevault User“ und „Keevault Reader“ im Richtlinien-Paket (ohne Purge, Schlüssel, Zertifikate, Rollen).
- Jedes Release mit SHA256SUMS.txt und SBOM (CycloneDX); CodeQL und Dependabot im Repository.
- Sicherheitsmodell überarbeitet (Datenhaltung, Anmeldung und App-Registrierung, Rollen, Passkey-Threat-Model, Telemetrie und Verbindungen, Lieferkette, Reifegrad); Website mit FAQ und „Wichtige Sicherheitsfragen“, Hilfe in der App verlinkt beides.
- Transparenz macht jetzt das ganze Fenster durchsichtig (Leicht 90 %, Stark 75 %).

### English
- Security hardening (review findings): copying sets the markers against clipboard history and cloud clipboard also when the PowerShell helper is blocked (own helper); crash dumps off, old ones deleted, Keevault excluded from Windows Error Reporting; vault info shows which metadata is readable in plain text without extra protection.
- Narrow Azure roles “Keevault User” and “Keevault Reader” in the policy package (no purge, keys, certificates, roles).
- Every release with SHA256SUMS.txt and an SBOM (CycloneDX); CodeQL and Dependabot in the repository.
- Security model reworked (data storage, sign-in and app registration, roles, passkey threat model, telemetry and connections, supply chain, maturity); website with FAQ and “Key security questions”, the in-app help links both.
- Transparency now makes the whole window see-through (light 90 %, strong 75 %).

## 0.8.2 – 2026-10-31
- Löschen ohne eigenen Papierkorb: Wiederhergestellt wird mit Bordmitteln im Azure-Portal (Key Vault → Secrets → Verwaltete gelöschte Secrets). Der Löschdialog nennt die Aufbewahrungsfrist des Tresors („nur 90 Tage wiederherstellbar“), bei Datei-Tresoren „keine Aufbewahrungsfrist“.
- Suchleiste neu: bündig mit der mittleren Spalte, mit Luft zur Liste, Fokus-Ring und Umschalter Tresor | Alle im Feld.
- Website: Live-Demo unter keevault.de/demo.html – dieselbe Oberfläche wie die App mit Beispieldaten, komplett im Browser; Screenshots der Website hell und dunkel (passend zum Design der Seite), das Hauptbild automatisch aus der Demo (npm run demo:shots).
- Menü → Ansicht: Zoom (auch Strg + / Strg − / Strg 0) und Transparenz (Aus, Leicht, Stark).

### English
- Deleting without a trash of its own: recovery happens with Azure's own tools in the portal (Key Vault → Secrets → Manage deleted secrets). The delete dialog names the vault's retention period ("recoverable for 90 days only"), for file vaults "no retention period".
- New search bar: flush with the middle column, with room above the list, a focus ring and the Vault | All switch inside the field.
- Website: live demo at keevault.de/en/demo.html – the same interface as the app with sample data, entirely in the browser; website screenshots in light and dark (matching the page's theme), the main picture taken automatically from the demo (npm run demo:shots).
- Menu → View: zoom (also Ctrl + / Ctrl − / Ctrl 0) and transparency (off, light, strong).

## 0.8.1 – 2026-10-31
- „Link kopieren“ für Einträge (Aktionen, Rechtsklick, Popup der Erweiterung): ein Web-Link, der in Teams und E-Mail anklickbar ist und den Eintrag direkt in Keevault öffnet. Tresor und Eintrag stehen nur hinter dem # und erreichen keinen Server; der Link gibt keinen Zugriff – öffnen kann ihn nur, wer Rechte auf den Tresor hat. Fehlt der Tresor in der App, bietet Keevault an, ihn hinzuzufügen; ist die App gesperrt, öffnet sich der Eintrag nach dem Entsperren.
- Suche: standardmäßig im aktuellen Tresor, mit einem Umschalter „Tresor | Alle“ im Suchfeld; Treffer aus allen Tresoren nach Tresor gruppiert.
- Hilfe unten links (oder F1): Tipps für jeden Tag und Links in die Wissensdatenbank (Erste Schritte, Passkeys, Teilen, Fehlerbehebung, Support); bleibt auch bei vielen Tresoren an seinem Platz.
- Obere Leiste: Suche über der mittleren Spalte, „Neu“ an der Kante der rechten Spalte; Sperren- und Menüknopf reagieren wieder (der Verschiebestreifen fing ihre Klicks ab); schmale Scrollleisten.

### English
- “Copy link” for entries (actions, right-click, extension popup): a web link that is clickable in Teams and mail and opens the entry right in Keevault. Vault and entry sit only behind the # and reach no server; the link grants no access – only people with rights on the vault can open it. If the vault is missing in the app, Keevault offers to add it; if the app is locked, the entry opens after unlocking.
- Search: in the current vault by default, with a “Vault | All” switch in the field; hits from all vaults grouped by vault.
- Help bottom left (or F1): everyday tips and links into the knowledge base (getting started, passkeys, sharing, troubleshooting, support); stays in place however many vaults there are.
- Top bar: search above the middle column, “New” at the edge of the right column; lock and menu buttons respond again (the drag strip caught their clicks); thin scrollbars.

## 0.8.0 – 2026-10-31
- Fenster ohne Titelleiste: Das Logo sitzt nahtlos oben links, die Windows-Knöpfe in den Farben der App oben rechts.
- Hauptmenü hinter dem Burger neben dem Logo: Konto, Neu laden, Einstellungen, Werkzeuge (Passwort-Generator, Passwort-Check, Zugriffsbericht) und Sperren; Sperren zusätzlich als eigener Knopf.
- Suche in der oberen Leiste, mittig über Liste und Details (Strg+F).
- Listenkopf: Der Tresorname steht voll da, die Markierungen (Verwalten, Demo …) darunter; Zähler, Knöpfe und Markierungen auf gemeinsamen Linien.

### English
- Window without title bar: the logo sits seamlessly top left, the Windows buttons in the app's colours top right.
- Main menu behind the burger next to the logo: account, reload, settings, tools (password generator, password check, access report) and lock; lock also as its own button.
- Search in the top bar, centred above list and details (Ctrl+F).
- List heading: the vault name in full, the badges (Manage, Demo …) below; counts, buttons and badges on shared lines.

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
