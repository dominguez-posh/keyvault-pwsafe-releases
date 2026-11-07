// The approval dialog for a release signature (#378): one page, built from what the main process hashed itself. It
// shows version, commit, channel, SHA-512 of the manifest and of the installer, the hash of SHA256SUMS.txt (which the
// manifest carries, so the signature covers every file of the release) and every file with its SHA-256. The same page
// carries the confirmation for entering a new approver (setup). The confirm button works only after the waiting time
// (#368), only for a real click, and the time starts over with every key press, so Enter or Space (also right after the
// dialog opened) confirm nothing: only a mouse click does. No Electron import: the HTML is built and tested here,
// desktop/main/release-sign.js shows it in its own window with its own preload.

export const CONFIRM_DELAY_MS = 6000;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** → complete HTML document (CSP: no external resource, one inline script with a nonce). */
export function releaseDialogHtml(info, { nonce, delayMs = CONFIRM_DELAY_MS, approverRequired = false } = {}) {
  return info.setup ? page(setupBody(info, approverRequired), nonce, delayMs, 'Freigeber eintragen') : page(releaseBody(info, approverRequired), nonce, delayMs, 'Signieren');
}

function setupBody(info, approverRequired) {
  return `<h1>Release-Freigeber eintragen</h1>
<div class="note">Nur bestätigen, wenn du das Einrichten gerade selbst gestartet hast. Danach fragt Windows nach deinem FIDO2-Sicherheitsschlüssel${approverRequired ? ' und zusätzlich nach einem bisherigen Freigeber' : ''}.</div>
<dl>
<dt>Signierschlüssel</dt><dd class="hash">${info.publicKey ? esc(info.publicKey) : 'wird neu angelegt'}</dd>
<dt>Eingetragene Freigeber</dt><dd>${Number(info.existing)}</dd>
</dl>`;
}

function releaseBody(info, approverRequired) {
  const rows = info.files.map((f) => `<tr><td>${esc(f.name)}</td><td class="num">${f.size}</td><td class="hash">${esc(f.sha256)}</td></tr>`).join('');
  const channel = info.channel === 'beta' ? 'Early Access (Beta)' : 'Stable (Prod)';
  return `<h1>Release signieren</h1>
<div class="note">Nur bestätigen, wenn du das Signieren gerade selbst gestartet hast und die Werte stimmen.${approverRequired ? ' Danach verlangt Windows die Berührung deines Sicherheitsschlüssels.' : ''}</div>
<dl>
<dt>Version</dt><dd><b>${esc(info.version)}</b></dd>
<dt>Kanal</dt><dd>${esc(channel)}</dd>
<dt>Commit</dt><dd class="hash">${esc(info.commit)}</dd>
<dt>Manifest (SHA-512)</dt><dd class="hash">${esc(info.manifestSha512)}</dd>
<dt>Installer</dt><dd>${esc(info.installer.name)}<br><span class="hash">${esc(info.installer.sha512)}</span></dd>
<dt>SHA256SUMS.txt</dt><dd class="hash">${esc(info.sums)}</dd>
</dl>
<div class="files"><table><thead><tr><th>Datei</th><th class="num">Bytes</th><th>SHA-256</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function page(body, nonce, delayMs, goLabel) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${esc(nonce)}'">
<title>Release</title>
<style>
:root{color-scheme:light dark;--bg:#f5f6f8;--fg:#1b1d22;--muted:#5d6370;--line:#d6d9e0;--accent:#1f6feb;--warn:#a15c00}
@media (prefers-color-scheme:dark){:root{--bg:#18191d;--fg:#eceef2;--muted:#9aa0ac;--line:#33363e;--accent:#4c8dff;--warn:#e0a040}}
body{margin:0;padding:16px 20px;font:13px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
h1{font-size:17px;margin:0 0 4px}dl{display:grid;grid-template-columns:140px 1fr;gap:4px 12px;margin:12px 0}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
.hash{font:11px/1.35 ui-monospace,Consolas,monospace}table{border-collapse:collapse;width:100%;margin:6px 0}td,th{border-bottom:1px solid var(--line);padding:3px 6px;text-align:left}.num{text-align:right}
.files{max-height:150px;overflow:auto;border:1px solid var(--line)}.note{color:var(--warn);margin:8px 0}
.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}button{font:inherit;padding:7px 16px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--fg)}
#go{background:var(--accent);border-color:var(--accent);color:#fff}#go[aria-disabled=true]{opacity:.45}
</style></head><body>
${body}
<div class="actions"><button id="no" type="button">Abbrechen</button><button id="go" type="button" aria-disabled="true"></button></div>
<script nonce="${esc(nonce)}">
(() => {
  const delay = ${Number(delayMs)};
  const go = document.getElementById('go');
  let ready = false, timer = null, left = 0, tick = null;
  const label = () => { go.textContent = ready ? ${JSON.stringify(goLabel)} : ${JSON.stringify(goLabel)} + ' (' + Math.ceil(left / 1000) + ' s)'; go.setAttribute('aria-disabled', String(!ready)); };
  const start = () => {
    clearTimeout(timer); clearInterval(tick); ready = false; left = delay; label();
    tick = setInterval(() => { left = Math.max(0, left - 250); label(); }, 250);
    timer = setTimeout(() => { ready = true; clearInterval(tick); label(); }, delay);
  };
  window.addEventListener('keydown', start, true);
  document.getElementById('no').addEventListener('click', () => window.releaseDialog.decide(false));
  go.addEventListener('click', (e) => { if (ready && e.isTrusted) window.releaseDialog.decide(true); });
  start();
  window.releaseDialog.ready(document.body.innerText.length > 40 && !!document.getElementById('no'));
})();
</script></body></html>`;
}
