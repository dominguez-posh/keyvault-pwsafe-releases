// When the app may sign a release at all (#378). Pure and without Electron imports: the menu asks it (api/app.js) and the
// signing module asks it again right before the dialog. Refused: an app that is not installed (a development copy is
// changed by whoever started it), demo and smoke runs, and every start with a debugging or injection switch – through
// those a process of the same account could read the key from memory or click the dialog.
//
// Chromium reads a switch as -name, --name and /name in any letter case (B3), so the command line is matched that way
// and, in the app, additionally asked through app.commandLine.hasSwitch(name), which is what Chromium itself decides on.

export const BLOCKED_SWITCHES = [
  'remote-debugging-port', 'remote-debugging-pipe', 'remote-allow-origins', 'inspect', 'inspect-brk', 'inspect-port', 'inspect-wait',
  'js-flags', 'enable-logging', 'user-data-dir', 'disable-features', 'enable-features', 'load-extension', 'host-rules', 'proxy-server',
  'auto-open-devtools-for-tabs', 'renderer-startup-dialog', 'no-sandbox', 'disable-web-security', 'enable-automation',
];
// The ones Electron could set itself at start-up (features, profile folder, sandbox) are only matched on the command line.
const ENGINE_SWITCHES = BLOCKED_SWITCHES.filter((n) => !['enable-features', 'disable-features', 'user-data-dir', 'no-sandbox', 'enable-logging', 'proxy-server', 'host-rules'].includes(n));
const BLOCKED = new RegExp(`^(--|-|/)(${BLOCKED_SWITCHES.join('|')})(=|$)`, 'i');

/** → null when signing is allowed, otherwise the reason (German, shown to the person). hasSwitch: app.commandLine.hasSwitch. */
export function signingRefusal({ packaged, argv, demo, smoke, hasSwitch }) {
  if (smoke) return 'Im Testlauf signiert Keevault nichts.';
  if (demo) return 'Im Demo-Modus signiert Keevault nichts.';
  if (!packaged) return 'Release signieren gibt es nur in der installierten App.';
  const bad = (argv || []).slice(1).find((a) => BLOCKED.test(a)) || ENGINE_SWITCHES.find((n) => hasSwitch?.(n));
  if (bad) return `Keevault wurde mit einem Debug-Schalter gestartet (${String(bad).replace(/^[-/]+/, '').split('=')[0]}) – so signiert es nicht. Ohne den Schalter neu starten.`;
  return null;
}

/** The same for the running app: electronApp is Electron's `app`. */
export const appSigningRefusal = (electronApp, { demo, smoke }) => signingRefusal({
  packaged: electronApp.isPackaged, argv: process.argv, demo: !!demo, smoke: !!smoke, hasSwitch: (n) => electronApp.commandLine.hasSwitch(n),
});
