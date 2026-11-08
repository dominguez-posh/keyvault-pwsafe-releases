// Masking for the diagnostics log (#484): Azure paths and error texts carry subscription IDs, object and tenant IDs
// (GUIDs) and user names (UPNs, also URL-encoded in Graph paths). The log keeps method, host, status and timing;
// these values never reach the file. No dependencies, so the desktop log and core code (#479) can both use it.

const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// user@domain, also as user%40domain in a URL path.
const UPN = /[^\s"'<>()/?&=]+(@|%40)[^\s"'<>()/?&=]+/gi;

/** Log text without subscription IDs, GUIDs and UPNs. A GUID keeps its first four characters to tell entries apart. */
export function maskLogText(text) {
  return String(text ?? '')
    .replace(/(\/subscriptions\/)[^/\s"'?]+/gi, '$1********')
    .replace(GUID, (g) => `${g.slice(0, 4)}****`)
    .replace(UPN, '***@***');
}

/** Line for keevault.log from the window's error report (level, message, detail are the window's text): masked too. */
export function windowLogLine({ level = 'error', message = '', detail = '' } = {}, now = new Date()) {
  return `${now.toISOString()} ${maskLogText(`${level} ${String(message).slice(0, 500)}${detail ? ` | ${String(detail).slice(0, 1500)}` : ''}`)}\n`;
}
