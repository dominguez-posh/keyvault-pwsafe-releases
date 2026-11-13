# Sicherheitsmeldungen: interner Ablauf und Meldeweg nach dem Cyber Resilience Act

Stand: 11.11.2026 (#345). Dieses Dokument beschreibt, wie eine Sicherheitsmeldung zu Keevault bei uns eingeht, wer
sie bewertet und wer eine Meldung an die Behörden abgibt. Wie Außenstehende eine Schwachstelle melden, steht in
[SECURITY.md](../SECURITY.md); das Sicherheitsmodell in [SICHERHEIT.md](SICHERHEIT.md).

> **Keine Rechtsberatung.** Das Team gibt keine rechtliche Einschätzung ab. Dieses Dokument legt nur den Ablauf
> fest. Ob und ab wann Keevault im Sinne des Cyber Resilience Act als Produkt gilt, das „auf dem Markt
> bereitgestellt“ wird, und ob die Meldepflichten damit greifen, klärt der Inhaber rechtlich. Bis das geklärt ist,
> gehen wir im Zweifel so vor, als gälte die Pflicht.

## Quelle der Fristen und Pflichten

Verordnung (EU) 2024/2847 (Cyber Resilience Act, „CRA“), deutsche Fassung im Amtsblatt:
<https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=OJ:L_202402847>. Die Angaben unten wurden am 11.11.2026 gegen
diesen Text geprüft; die Fundstelle steht jeweils dabei. Vor einer echten Meldung den aktuellen Text und die Hinweise
der Meldeplattform noch einmal lesen.

- Art. 14 gilt seit dem 11.09.2026 (Art. 71 Abs. 2); die übrige Verordnung ab dem 11.12.2027.
- Punkte mit dem Vermerk **„zu prüfen“** sind nicht gegen eine Quelle geprüft und gelten nicht als Tatsache.

## Zuständigkeiten

| Schritt | Wer |
| --- | --- |
| Eingang sichten, Issue anlegen | Bug- und Feature-Manager, Website-Manager (Website-Meldungen), technische Leitung (CTO) |
| Technische Bewertung | Sicherheitsprüfer zusammen mit der technischen Leitung (CTO) |
| Entscheidung, ob gemeldet wird, und die Meldung selbst | **ausschließlich der Inhaber** |
| Korrektur und Release | Entwicklung, Release-Entscheidung technische Leitung, Prod-Freigabe Inhaber ([RELEASE.md](RELEASE.md)) |
| Information der Nutzer (Entwurf) | Doku und Support; Freigabe und Versand durch den Inhaber |

Niemand außer dem Inhaber meldet an eine Behörde, spricht mit ihr oder legt dort ein Konto an. Das Team bereitet nur
vor.

## 1. Eingang

Eine Meldung kann auf diesen Wegen ankommen:

- **E-Mail an security@keevault.de.** Die Adresse läuft über das Catch-all-Postfach der Domain; es gibt kein eigenes
  Postfach dafür. Auch Mails an info@keevault.de mit dem Betreff „Sicherheit“ (so steht es in SECURITY.md) zählen.
- **GitHub:** private Meldung über *Security → Report a vulnerability*, oder ein Issue, das sich als
  Sicherheitsproblem herausstellt.
- **Website:** Fehlermeldung oder Support-Anfrage über keevault.de.
- **Eigene Funde:** Sicherheitsprüfung, Tests, Hinweise aus Abhängigkeiten (z. B. Electron, MSAL), Auffälligkeiten
  bei Website, Update-Feed oder Signaturschlüsseln.

Sofort nach dem Eingang:

1. **Zeitpunkt der Kenntnis festhalten** (Datum und Uhrzeit). Ab hier laufen die Fristen.
2. Issue im privaten Repo mit dem Label `security` anlegen. Keine Details in öffentliche Issues, keine
   Tenant-Daten, IDs, Kundendaten oder E-Mail-Adressen der meldenden Person ins Issue.
3. Sicherheitsprüfer und technische Leitung benachrichtigen. Sicherheitsfehler gehen vor allem anderen.
4. Besteht der Verdacht auf aktive Ausnutzung oder einen schwerwiegenden Vorfall: **den Inhaber sofort informieren**,
   nicht erst nach der Bewertung.

## 2. Bewertung (Sicherheitsprüfer und CTO)

Ziel ist eine schriftliche Einschätzung im Issue, so früh wie möglich und deutlich vor Ablauf der 24 Stunden.

**Was ist meldepflichtig?** Zwei Fälle (Art. 14 Abs. 1 und 3):

- **Aktiv ausgenutzte Schwachstelle** in Keevault: eine Schwachstelle, „zu der verlässliche Nachweise dafür
  vorliegen, dass ein böswilliger Akteur sie in einem System ohne Zustimmung des Systemeigners ausgenutzt hat“
  (Art. 3 Nr. 42). Eine Schwachstelle, die nur gefunden und behoben wurde, ohne Hinweis auf Ausnutzung, fällt nicht
  darunter.
- **Schwerwiegender Sicherheitsvorfall**, der sich auf die Sicherheit von Keevault auswirkt. Schwerwiegend ist er
  nach Art. 14 Abs. 5, wenn er
  - die Fähigkeit des Produkts beeinträchtigt oder beeinträchtigen kann, Verfügbarkeit, Authentizität, Integrität
    oder Vertraulichkeit sensibler oder wichtiger Daten oder Funktionen zu schützen, oder
  - zur Einführung oder Ausführung von Schadcode im Produkt oder im Netzwerk und Informationssystem eines Nutzers
    geführt hat oder führen kann.

  Beispiele, an die wir bei Keevault denken müssen: Signaturschlüssel für Updates oder Lizenzen abgeflossen,
  Build-Rechner, GitHub-Konto, Release-Repo oder Website mit Update-Feed kompromittiert, ein ausgeliefertes Release
  mit verändertem Inhalt.

**Fragen für die Bewertung:**

- Welche Teile sind betroffen (Desktop-App, Erweiterung, Windows-Passkey-Anbieter, Setup-Werkzeug, Website/Update)?
- Welche Versionen und Kanäle (Prod, Early Access)?
- Was kann ein Angreifer erreichen, unter welchen Voraussetzungen? Schweregrad wie in der Sicherheitsprüfung üblich.
- Gibt es Hinweise auf Ausnutzung? Woher, wie verlässlich?
- Gibt es eine Sofortmaßnahme für Nutzer, bevor ein Update da ist?
- Sind personenbezogene Daten betroffen? Dann kann zusätzlich eine Meldung nach Art. 33 DSGVO nötig sein
  (**zu prüfen**, entscheidet der Inhaber).

Ergebnis im Issue: Einordnung (meldepflichtig ja / nein / unklar), Begründung, Empfehlung an den Inhaber. Bei
„unklar“ wird der Inhaber so informiert, als wäre es meldepflichtig.

## 3. Entscheidung und Meldung (nur der Inhaber)

Der Inhaber entscheidet auf Grundlage der Bewertung und meldet selbst.

- **Wohin:** über die einheitliche Meldeplattform der ENISA (Single Reporting Platform, Art. 16), und zwar über den
  Endpunkt des CSIRT, das in dem Mitgliedstaat der Hauptniederlassung als Koordinator benannt ist; die Meldung ist
  damit zugleich für die ENISA zugänglich (Art. 14 Abs. 1, 3 und 7).
- Für Deutschland gehen wir vom BSI als zuständigem CSIRT aus. **Zu prüfen:** die Benennung des BSI als Koordinator
  und die Adresse des deutschen Endpunkts der Plattform sind hier nicht gegen eine Quelle geprüft.
- **Zu prüfen:** Registrierung auf der Plattform. Das Konto sollte bestehen, bevor der erste Fall eintritt.

### Fristen

Alle Fristen laufen ab dem Zeitpunkt, an dem wir Kenntnis erlangt haben, außer beim Abschlussbericht.

| Schritt | Aktiv ausgenutzte Schwachstelle (Art. 14 Abs. 2) | Schwerwiegender Sicherheitsvorfall (Art. 14 Abs. 4) |
| --- | --- | --- |
| Frühwarnung | unverzüglich, spätestens **24 Stunden** nach Kenntnis (Buchst. a) | unverzüglich, spätestens **24 Stunden** nach Kenntnis (Buchst. a) |
| Meldung | unverzüglich, spätestens **72 Stunden** nach Kenntnis (Buchst. b) | unverzüglich, spätestens **72 Stunden** nach Kenntnis (Buchst. b) |
| Abschlussbericht | spätestens **14 Tage**, nachdem eine Korrektur- oder Risikominderungsmaßnahme zur Verfügung steht (Buchst. c) | innerhalb **eines Monats** nach Übermittlung der Meldung aus Buchst. b (Buchst. c) |

Das CSIRT kann zwischendurch einen Zwischenbericht verlangen (Art. 14 Abs. 6). Die Fristen laufen auch am Wochenende
und an Feiertagen; die Verordnung nennt Stunden und Tage ohne Ausnahme für Werktage.

### Was die Meldungen enthalten müssen

- **Frühwarnung, Schwachstelle:** dass eine aktiv ausgenutzte Schwachstelle vorliegt, und die Mitgliedstaaten, in
  denen das Produkt nach unserer Kenntnis bereitgestellt wurde.
- **Frühwarnung, Vorfall:** mindestens, ob der Verdacht auf rechtswidrige oder böswillige Handlungen besteht;
  gegebenenfalls die Mitgliedstaaten wie oben.
- **Meldung (72 h):** soweit verfügbar allgemeine Angaben zum Produkt, zur Art der Ausnutzung und der Schwachstelle
  bzw. zur Art des Vorfalls mit erster Bewertung; ergriffene Korrektur- oder Risikominderungsmaßnahmen; was Nutzer
  selbst tun können; gegebenenfalls, wie sensibel wir die Angaben einstufen.
- **Abschlussbericht, Schwachstelle:** Beschreibung mit Schweregrad und Auswirkungen; falls verfügbar Angaben zum
  Angreifer; Angaben zum Sicherheitsupdate oder zu anderen Korrekturmaßnahmen.
- **Abschlussbericht, Vorfall:** ausführliche Beschreibung mit Schweregrad und Auswirkungen; Art der Bedrohung bzw.
  wahrscheinliche Ursache; getroffene und laufende Abhilfemaßnahmen.

## 4. Nutzer informieren

Nach Art. 14 Abs. 8 informiert der Hersteller die betroffenen Nutzer, gegebenenfalls alle Nutzer, über die
Schwachstelle oder den Vorfall und erforderlichenfalls über Maßnahmen, die sie selbst ergreifen können.

- Doku und Support entwirft die Texte auf Deutsch und Englisch; der Inhaber gibt frei.
- Wege: CHANGELOG.md (erscheint im Update-Dialog der App), Website, bei Bedarf ein Sicherheitshinweis auf GitHub.
  Änderungen an der Website laufen über den Website-Manager.
- Inhalt: was betroffen ist, in welcher Version es behoben ist, was die Person prüfen oder tun soll. Keine
  Zusagen zu Terminen, keine Details, die eine Ausnutzung erleichtern, solange kein Update bereitsteht.
- Die meldende Person bekommt eine Rückmeldung (SECURITY.md nennt 5 Werktage) und wird auf Wunsch als Finder
  genannt. Antworten entwirft Doku und Support; den Versand klärt die technische Leitung mit dem Inhaber.

## 5. Korrektur und Release

- Korrektur auf einem eigenen Branch je Issue mit Gegentest, Abnahme wie üblich.
- Regelweg: Early Access, dann Prod mit Freigabe des Inhabers ([RELEASE.md](RELEASE.md)).
- Notfall: direkt nach Prod mit `release.mjs --publish --hotfix`, nur auf Entscheidung der technischen Leitung und
  mit Freigabe des Inhabers.
- Sind Schlüssel betroffen (Update-Signatur, Lizenz, Zertifikat), gehört der Schlüsselwechsel zur Korrektur.
- Der Zeitpunkt, an dem die Korrektur für Nutzer verfügbar ist, wird im Issue festgehalten: ab da laufen die
  14 Tage für den Abschlussbericht bei einer aktiv ausgenutzten Schwachstelle.

## 6. Dokumentation

Im Issue des Falls, ohne personenbezogene Daten der meldenden Person:

- Zeitpunkt der Kenntnis, Eingangsweg
- Bewertung mit Begründung und die Entscheidung des Inhabers, auch wenn nicht gemeldet wurde
- Zeitpunkte von Frühwarnung, Meldung und Abschlussbericht (die Inhalte der Meldungen bewahrt der Inhaber auf)
- betroffene und korrigierte Versionen, Zeitpunkt der Verfügbarkeit der Korrektur
- wann und wie Nutzer informiert wurden
- was wir daraus ändern (Prüfung im Test, Regel, Dokumentation)

## Prüfliste

- [ ] Zeitpunkt der Kenntnis notiert
- [ ] Privates Issue angelegt, keine Details öffentlich
- [ ] Sicherheitsprüfer und technische Leitung informiert; bei Verdacht auf Ausnutzung oder schwerwiegenden Vorfall
      sofort auch der Inhaber
- [ ] Bewertung im Issue: betroffene Teile und Versionen, Auswirkung, Hinweise auf Ausnutzung, Sofortmaßnahme
- [ ] Einordnung: aktiv ausgenutzte Schwachstelle / schwerwiegender Sicherheitsvorfall / nicht meldepflichtig / unklar
- [ ] Entscheidung des Inhabers festgehalten
- [ ] Frühwarnung innerhalb von 24 Stunden (Inhaber)
- [ ] Meldung innerhalb von 72 Stunden (Inhaber)
- [ ] Korrektur gebaut, getestet, veröffentlicht; Zeitpunkt der Verfügbarkeit notiert
- [ ] Nutzer informiert (Deutsch und Englisch), meldende Person hat eine Rückmeldung
- [ ] Abschlussbericht: 14 Tage nach Verfügbarkeit der Korrektur (Schwachstelle) bzw. ein Monat nach der Meldung
      (Vorfall)
- [ ] DSGVO-Meldung geprüft (Inhaber)
- [ ] Fall im Issue vollständig dokumentiert, Folgerungen umgesetzt

## Offen

- Rechtliche Einordnung „auf dem Markt bereitgestellt“ und damit die Geltung der Pflichten für Keevault: klärt der
  Inhaber.
- Benennung des BSI als Koordinator-CSIRT, Endpunkt und Registrierung auf der Meldeplattform: zu prüfen.
- Ob Art. 14 auch für Versionen gilt, die vor dem 11.12.2027 veröffentlicht wurden (Übergangsregel in Art. 69): zu
  prüfen.
- SECURITY.md nennt info@keevault.de als Meldeadresse, dieser Ablauf security@keevault.de. Ob SECURITY.md und die
  Website auf security@ umgestellt werden, ist nicht entschieden.
