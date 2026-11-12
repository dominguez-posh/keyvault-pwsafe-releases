// The smoke run needs an unlocked Windows session (#526). While the session is locked, Windows refuses the clipboard
// to every process (OpenClipboard: ERROR_ACCESS_DENIED, no window holds it), so the clipboard areas time out and the
// areas after them fall behind. Two full runs of 0.9.33 went red that way: the PC locked itself during the run.
// So a run in a locked session stops at once and says why, a lock during the run is named as the cause, and the run
// asks Windows to keep the display on, which keeps the idle lock away where no policy enforces it.
// Electron's powerMonitor and powerSaveBlocker come in from desktop/main/smoke.js: no Electron import here, the unit
// test drives it with stand-ins.

export const LOCKED_AT_START = 'Windows-Sitzung ist gesperrt: der Smoke-Lauf braucht eine entsperrte Sitzung (gesperrt verweigert Windows die Zwischenablage, #526). Entsperren und neu starten.';

/** Text for a lock during the run: when and in which part, so the failures after it read as consequences. */
export const lockedDuring = (time, stage) => `Windows-Sitzung während des Laufs gesperrt (${time}, Teil ${stage}): Zwischenablage gesperrt, Fehler ab hier sind Folgefehler (#526)`;

/**
 * Watches the session for the run: { lockedAtStart } – true means the run must stop (with LOCKED_AT_START).
 * monitor: Electron's powerMonitor, blocker: powerSaveBlocker, errors: the run's error list, stage(): current part.
 */
export function watchSmokeSession({ monitor, blocker, errors, stage = () => '?', now = () => new Date() }) {
  if (monitor.getSystemIdleState(1) === 'locked') return { lockedAtStart: true };
  blocker.start('prevent-display-sleep');
  monitor.on('lock-screen', () => errors.push(lockedDuring(now().toLocaleTimeString('de-DE'), stage())));
  return { lockedAtStart: false };
}
