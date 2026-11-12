# Keevault Design-Vorgabe

Stand: 05.11.2026, Version 0.9.27, Issue #356. Diese Vorgabe beschreibt den **Ist-Stand im Code**. Von Lucas entschiedene, noch nicht umgesetzte Änderungen stehen unter [Entscheidungen](#entscheidungen), offene Punkte unter [Befunde](#befunde).

## Entscheidungen

| # | Entscheidung von Lucas (05.11.2026) | Zielwerte | Umsetzung |
|---|---|---|---|
| E1 | Die Website wird an das Produkt-Blau angeglichen. | `--accent` hell `#0f6cbd`, dunkel `#479ef5`; Hover und `--accent-soft` wie im Produkt-Satz | #363, Website Manager |
| E2 | Der Radius von Knöpfen und Eingaben wird einheitlich 10 px. | Produkt und Setup 10 px, Website bleibt | #364, in App und Erweiterung erst nach den Sicherheitsfixes, nicht in 0.9.28 |

Neue Oberflächen nutzen bereits diese Zielwerte. Die übrigen Web-Farben und Token-Namen bleiben, dazu gibt es keine Entscheidung. Radien anderer Elemente sind ebenfalls nicht entschieden.

## Regeln für neue Oberflächen

1. Farben nur über die Tokens der jeweiligen Oberfläche, keine neuen festen Hex-Werte.
2. Die Markenfarbe ist Blau (Entscheidung von Lucas vom 01.11.2026). Andere Farben werden nicht von sich aus vorgeschlagen.
3. Jede Oberfläche muss hell und dunkel funktionieren.
4. Text auf `--accent` nutzt `--on-accent` (Website: siehe [Bedienelemente](#website-und-portale)), nie festes Weiß.
5. Weicht etwas von dieser Vorgabe ab, entscheidet Lucas über die Design-Verantwortliche und den Teamleiter.

## Geltungsbereich

Es gibt zwei Token-Sätze:

| Satz | Datei | Gilt für |
|---|---|---|
| **Produkt** | `extension/styles/app.css` | Desktop-App, Erweiterung, Mobile-App. Setup (`windows/Setup/Program.cs`) führt eine Kopie der Werte. |
| **Web** | `website/assets/style.css` | Website, Admin-Backend und Partner-Portal (`website/php/admin/admin.css`) |

Hell und dunkel: Die App wählt im Menü zwischen System, hell und dunkel. Erweiterung und Mobile-App folgen dem System. Die Website folgt dem System und hat zusätzlich einen Umschalter (`data-theme`).

## Farben

| Rolle | Produkt hell | Produkt dunkel | Web hell | Web dunkel |
|---|---|---|---|---|
| Hintergrund `--bg` | `#f5f6f8` | `#18191d` | `#f7f8fb` | `#0d1119` |
| Fläche `--surface` | `#ffffff` | `#212328` | `#ffffff` | `#151b26` |
| Fläche 2 `--surface-2` | `#eef0f4` | `#2a2d33` | `#eef1f7` | `#1c2431` |
| Linie (Produkt `--border`, Web `--line`) | `#dadee5` | `#383c45` | `#dde2ec` | `#283244` |
| Text `--text` | `#1b1d22` | `#eceef2` | `#141a26` | `#e8ecf4` |
| Nebentext `--muted` | `#5d6472` | `#a3a9b6` | `#5a6478` | `#9aa5ba` |
| **Akzent `--accent`** | `#0f6cbd` | `#479ef5` | `#2f5bea` | `#7c9bff` |
| Akzent Hover (Produkt `--accent-hover`, Web `--accent-2`) | `#115ea3` | `#62abf5` | `#1c3fb8` | `#a3b9ff` |
| Akzent weich `--accent-soft` | `#e6f0fa` | `#1f3247` | `#e6ecff` | `#1d2a4d` |
| Text auf Akzent | `#ffffff` | `#0b1520` | `#ffffff` | `#0d1119` |
| Gefahr `--danger` | `#c42b1c` | `#f1707a` | `#c0262d` | `#ff6b6b` |
| Erfolg (Produkt `--success`, Web `--ok`) | `#107c10` | `#6ccb5f` | `#18794e` | `#4cc38a` |
| Warnung `--warn` | `#8a5300` | `#f7c25a` | `#a35c00` | `#f0a648` |

Nur im Produkt:

| Rolle | Hell | Dunkel |
|---|---|---|
| Gefahr weich `--danger-soft` | `#fbe9e7` | `#3b2225` |
| Warnung weich `--warn-soft` | `#fff4ce` | `#3a3020` |
| Passkey `--passkey` (Violett) | `#5b4fc4` | `#9d93f0` |
| Admin-Modus der App, `--accent` (Kupfer, nur `html.admin-theme`) | `#ac5500` | `#e07a1f` |

## Typografie

| | Produkt | Mobile-App | Web |
|---|---|---|---|
| Schrift | Segoe UI Variable Text, Segoe UI, system-ui | -apple-system, Segoe UI, Roboto, system-ui | system-ui, -apple-system, Segoe UI, Roboto |
| Fließtext | 14 px / 1,45 | 15 px / 1,45 | 16 px / 1,6 |
| Monospace | Cascadia Mono, Consolas | wie Produkt | Cascadia Code, Consolas |

**Produkt:** Klein 12 px, Abschnittslabel 11 px fett in Großbuchstaben mit `.06em` Laufweite, Dialogtitel 15 px, Listentitel 20 px, Eintragstitel 24 px, Sperrbildschirm 22 px.

**Web:** `h1` `clamp(2rem, 5vw, 3.2rem)`, `h2` `clamp(1.5rem, 3vw, 2rem)`, `h3` 1,15 rem, klein 0,9 rem, Gruppenlabel 0,75 bis 0,78 rem fett in Großbuchstaben.

## Abstände und Radien

Eine feste Abstandsskala gibt es nicht. Üblich sind:

| | Produkt | Web |
|---|---|---|
| Lücken | 4, 6, 8, 10, 12 px | 8, 12, 16, 20 px |
| Innenabstand Karte | Feldkarte 12 × 16 px, Detailbereich 26 × 30 px | Karte 22 px |
| Seitenraster | drei Spalten: Seitenleiste 250 px, Liste 380 px, Detail flexibel | Breite max. 1120 px, Rand 16 px, Abschnitt 56 px |

| Radius | Produkt | Web |
|---|---|---|
| Eingabe, Knopf | 6 px; Suchfeld und Hauptknöpfe des Sperrbildschirms 10 px | 10 px |
| Listenzeile | 12 px | 8 px (Navigation) |
| Karte | 16 px; Hauptflächen 18 px; Sperrbildschirm 20 px | 14 px (`--radius`) |
| Dialog | 10 px; Agent-Frage 20 px | keine eigene Vorgabe |
| Menü | 14 px (App) | keine eigene Vorgabe |
| Pille, Filter | 999 px | 999 px |

## Bedienelemente

### Produkt

| Element | Vorgabe |
|---|---|
| Knopf `.btn` | Mindesthöhe 32 px, Innenabstand 5 × 12 px, Radius 6 px, Schrift 500. Klein: 26 px. Sperrbildschirm: 38 px, Radius 10 px |
| Varianten | `.primary` Akzentfläche, `.danger` roter Text und roter Rand, Hover `--danger-soft` |
| Symbolknopf `.icon-btn` | 30 × 30 px, ohne Rand, Hover `--surface-2` |
| Deaktiviert | Deckkraft .55 (Symbolknopf .4) |
| Eingabe | Mindesthöhe 32 px, Rand `--border`. Fokus: Rand und 1 px Schatten in `--accent` |
| Tastaturfokus | 2 px Linie in `--accent`, Abstand 1 px |
| Listenzeile `.row-item` | App: Hover `--surface-2`, aktiv `--accent-soft`, Symbol 38 px. Erweiterung: Hover `--accent-soft`, aktiv `--surface-2` mit Akzentbalken, Symbol 36 px. Mobile: Symbol 40 px |
| Karte `.field-card` | Rand `--border`, Radius 16 px, Trennlinien zwischen den Feldern |
| Abzeichen `.badge` | 11 px fett, Radius 10 px, Varianten `accent`, `passkey`, `warn`, `danger` |
| Hinweis `.notice` | `--warn-soft`, Varianten `info` und `error`, Radius 6 px |
| Register `.tabs` | Segmente auf `--surface-2`, aktives Segment `--surface` mit leichtem Schatten |
| Filter `.pill` | Höhe 28 px, aktiv invertiert (`--text` als Fläche) |
| Dialog `.modal` | Breite bis 560 px, Radius 10 px, Schatten `--shadow` |
| Menü (App) | Radius 14 px, Milchglas, Zeilen 34 px, Hover neutral, Symbol wird Akzent, Rot nur bei Löschen |
| Sichere Karte (#459) | Fenster der App oder Erweiterung für PIN und Bestätigungen: Radius 16 px, Fläche `--surface`, Schatten, oben mittig über dem Browser- bzw. App-Fenster, Breite 400 bis 460 px, Höhe nach Inhalt. App: rahmenlos und transparent; Erweiterung: Browserfenster vom Typ `popup` behält die Titelleiste (Grenze des Browsers). Enter bestätigt (Freigabe der Release-Signatur nie per Enter, nur Mausklick nach Wartezeit), Esc bricht ab, Schließen zählt als Abbruch |
| Look des Popups (#509) | Die App lässt den Desktop durch das Fenster scheinen (Fenster-Transparenz); ein Browser-Popup kann das nicht. Nachgebildet mit denselben Tokens in `extension/popup/popup.css`: Hintergrund `--bg` mit weichem Verlauf aus `--accent` (16 %) und `--passkey` (9 %), Körnung `extension/styles/grain.svg` (7 % hell, 9 % dunkel), Kopfzeile, Liste und Detail als Glas (78 % `--surface`, Unschärfe 14 px). Text bleibt mindestens 4,5:1 (Smoke prüft hell und dunkel). Bei `prefers-reduced-transparency`, `prefers-contrast: more`, erzwungenen Farben oder ohne `backdrop-filter`: flache Flächen, kein Verlauf, keine Körnung |
| Meldung `.toast` | unten mittig, Fläche `#23262d`, Fehler `--danger` |
| Symbole | Linien-Icons im Lucide-Stil, 24 × 24 (`extension/core/dom.js`) |

### Website und Portale

| Element | Vorgabe |
|---|---|
| Knopf `.btn` | Innenabstand 12 × 20 px, Radius 10 px, Schrift 600 |
| Varianten | `.btn-primary` Akzentfläche, `.btn-ghost` Fläche mit Rand. Text auf Akzent: hell `#fff`, dunkel `#0d1119` |
| Kleiner Knopf (Portale) | `.row-actions .btn`: 7 × 12 px, 0,9 rem |
| Eingabe | Innenabstand 11 × 13 px, Radius 10 px, Fläche `--bg`. Fokus: 2 px Linie in `--accent` |
| Karte `.card` | Fläche `--surface`, Rand `--line`, Radius 14 px, Innenabstand 22 px |
| Hinweis `.notice` | Radius 10 px, Varianten `ok` und `err` |
| Status (Portale) `.status` | Pille 0,8 rem fett, Fläche `--surface-2`, Textfarbe nach Status |
| Tabelle (Portale) `.table` | 0,9 rem, Zeilenlinie `--line`, Kopf `--muted` |

### Portal-Layout

Admin-Backend und Partner-Portal teilen sich dieses Layout aus `admin.css`: Seitenleiste 220 px (`.portal-nav`) mit Gruppenlabels, aktiver Eintrag in `--accent-soft`, Inhalt daneben mit Kopf (`.portal-head`) und Kennzahlen (`.portal-stats`). Unter 860 px steht die Navigation oben.

**Leitstelle `/management`:** Sie nutzt den Web-Satz und dieses Portal-Layout. Das neue Blau erhält sie über die Tokens automatisch, solange sie keine festen Farbwerte verwendet. Eigene Farben und neue Bedienelemente stimmt der Website Manager vorher mit der Design-Verantwortlichen ab.

## Befunde

Die Bereinigung läuft über #361 (B1), #364 (B5, Knöpfe und Eingaben) und #362 (übrige).

| # | Befund | Stelle |
|---|---|---|
| B1 | **Kontrast zu gering:** Festes Weiß auf `--accent` ergibt in der dunklen Mobile-App nur 2,81:1 (nötig: 4,5:1 für Text, 3:1 für Symbole). Betrifft aktive Filter und den Plus-Knopf. | `mobile/www/mobile.css`, `.chips button.active`, `.fab` |
| B2 | **Erfolgston ignoriert den Dark Mode:** `.notice.ok` nutzt `--ok`, das im Produkt nicht existiert. Dadurch greift immer `#1a7f37`. | `desktop/renderer/desktop.css:228` |
| B3 | **Menüs nicht gleich:** Das Kontextmenü der Erweiterung soll laut Kommentar wie in der App aussehen, hat aber Radius 8 px statt 14 px und kein Milchglas. | `extension/popup/popup.css:18` |
| B4 | **Feste Farben ohne Token:** Bernstein in zwei Varianten (`#e3a400`, `#e8a400`), PIM-Violett `#8661c5`, Agent-Schreiben `#c27c0e`, Erfolgshaken `#1f9d55`. | `app.css`, `desktop.css` |
| B5 | **Viele Radien:** In `desktop.css` kommen rund ein Dutzend Werte vor, teils für gleichartige Elemente. Es fehlt eine Skala. | `desktop.css` |
| B6 | **Kein eigener Tastaturfokus auf Website und Portalen:** Knöpfe und Links zeigen nur den Browser-Standard. | `style.css`, `admin.css` |
| B7 | **Toter Code:** `.admin .tabs` wird nicht mehr verwendet. | `admin.css:4-6` |
| B8 | **Kopie der Farben im Setup:** Die Werte stehen doppelt und können auseinanderlaufen. | `windows/Setup/Program.cs:122` |
