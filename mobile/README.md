# Keevault Mobile (Vorschau)

Capacitor-App für Android und iOS um die gemeinsame Web-Oberfläche in `www/` (bündelt `extension/core` per esbuild).

## Bauen

```bash
cd mobile
npm install
node build.mjs            # www/bundle.js, Stylesheet und Logo
npx cap sync android      # kopiert www/ ins Android-Projekt
```

**Android** (JDK **21** – Capacitor 7 verlangt es – und Android SDK 35; `ANDROID_HOME`/`JAVA_HOME` gesetzt oder
`android/local.properties`):

```bash
cd android && ./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk (Debug-Signatur, "Unbekannte Quellen" auf dem Gerät erlauben)
```

**iOS** (nur auf einem Mac mit Xcode): `npx cap add ios && npx cap open ios`, dann in Xcode signieren und auf das
Gerät oder in TestFlight laden.

## Wie die App arbeitet

- Anmeldung per **Gerätecode** mit Microsofts Azure-CLI-Client (wie `az login --use-device-code`), keine
  App-Registrierung nötig. Tokens liegen im Arbeitsspeicher; das Refresh-Token wird mit der **App-PIN**
  verschlüsselt (PBKDF2 → AES-256-GCM) in den Capacitor-Preferences abgelegt.
- HTTP läuft nativ (`CapacitorHttp`), weil Key Vault keine CORS-Header liefert.
- Tresore werden wie am Desktop über ARM/Resource Graph gefunden, Listen kommen aus den Index-Secrets
  (`pws-index`), das Secret eines Eintrags wird erst beim Öffnen geladen.
- Detail und Editor stammen aus `extension/core/ui-item.js`; Logik aus `extension/core/session.js`.

## Noch offen

Geschützte Tresore (Passkey/Masterpasswort) auf dem Gerät entsperren, Datei-Tresore, Autofill, Biometrie,
Store-Veröffentlichung.
