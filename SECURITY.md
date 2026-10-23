# Sicherheit

Keevault verwaltet Passwörter und Passkeys – Sicherheitshinweise nehmen wir ernst und bearbeiten sie vorrangig.

## Schwachstelle melden

Bitte **nicht** als öffentliches Issue melden, sondern vertraulich:

- über GitHub: Reiter **Security → Report a vulnerability** (private Meldung), oder
- per E-Mail an **lizenz@keevault.de** mit dem Betreff „Sicherheit“.

Hilfreich sind: betroffene Version (in der App unten rechts), Schritte zum Nachvollziehen und die mögliche Auswirkung.
Du bekommst innerhalb von 5 Werktagen eine Rückmeldung. Wir veröffentlichen eine Lücke erst, wenn ein Update
bereitsteht, und nennen dich auf Wunsch als Finder.

## Was im Fokus steht

- Zugriff auf Einträge ohne Berechtigung (Key Vault, Datei-Tresor, zusätzliche Verschlüsselung)
- Abfluss von Passwörtern, Tokens oder Schlüsseln (Zwischenablage, Browser-Anbindung, Speicher, Protokolle)
- Passkey-Anbieter (Browser-Erweiterung, Windows-Passkey-Anbieter)
- Backups, Wiederherstellung, Einladungen

## Wie Keevault aufgebaut ist

Das Sicherheitsmodell beschreibt [docs/SICHERHEIT.md](docs/SICHERHEIT.md), den Aufbau [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md).
