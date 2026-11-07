// Checks of a remote desktop target before anything is started (#371). Host, port and user name end up in a line-based
// stdin protocol of the helper (windows/Setup/Rdp.cs), in a temporary .rdp file (one "key:type:value" per line) and in
// the command line of mstsc – a line break or an option-like host could add settings (drive redirection, alternate
// shell) or shift the fields. The host is checked like the SSH host; nothing else gets through.

import { t } from '../extension/core/i18n.js';

/** Host name, IPv4 or IPv6 (also in brackets) – nothing mstsc could read as an option, no spaces, no line breaks. */
export const RDP_HOST = /^[\w[][\w.:[\]-]*$/;
// Control characters and the Unicode line separators.
const hasControl = (v) => [...v].some((c) => { const n = c.charCodeAt(0); return n < 32 || n === 127 || n === 0x2028 || n === 0x2029; });

/** Throws a German UI error for an unusable target; returns the port as a number. */
export function checkRdpTarget(host, port, username) {
  if (typeof host !== 'string' || host.length > 253 || !RDP_HOST.test(host)) throw new Error(t('Ungültige Serveradresse'));
  let p = 3389;
  if (port != null && port !== '') {
    p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(t('Ungültiger Port'));
  }
  if (username != null && (typeof username !== 'string' || hasControl(username) || username.length > 512)) throw new Error(t('Ungültiger Benutzername für Remotedesktop'));
  return p;
}
