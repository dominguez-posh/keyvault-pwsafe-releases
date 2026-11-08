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
  if (info.remove) return page(removeBody(info), nonce, delayMs, 'Freigeber entfernen');
  return info.setup ? page(setupBody(info, approverRequired), nonce, delayMs, 'Freigeber eintragen') : page(releaseBody(info, approverRequired), nonce, delayMs, 'Signieren');
}

/**
 * A plain confirmation as the same kind of card (#459), for questions that used the Windows message box: title, a few
 * lines, "Allow" / "Deny". Enter confirms here, but only after the waiting time, only as a real key press and never while
 * the focus is on the deny button; `card.enter === false` turns Enter off (only a click confirms). Esc denies.
 */
export function confirmCardHtml(card, { nonce, delayMs = 1500 } = {}) {
  const lines = String(card.detail || '').split(/\r?\n/).filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('');
  return page(`<h1>${esc(card.title)}</h1>${lines}`, nonce, delayMs, card.go || 'OK', { enter: card.enter !== false, cancel: card.cancel || 'Ablehnen' });
}

// #437: removing a (lost) approver. Another registered key confirms, the one removed cannot.
function removeBody(info) {
  return `<h1>Release-Freigeber entfernen</h1>
<div class="note">Nur bestätigen, wenn du das Entfernen gerade selbst gestartet hast. Danach verlangt Windows die Berührung eines anderen eingetragenen Sicherheitsschlüssels, nicht des entfernten.</div>
<dl>
<dt>Freigeber</dt><dd><b>${esc(info.id)}</b></dd>
<dt>Credential-ID</dt><dd class="hash">${esc(info.credentialId)}</dd>
<dt>Danach eingetragen</dt><dd>${Number(info.remaining)}</dd>
</dl>
<div class="note">Der entfernte Schlüssel öffnet den Signierschlüssel hier nicht mehr. Sein Element in UPDATE_KEYS gilt in ausgelieferten Versionen weiter, bis eine neue Version es entfernt.</div>`;
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

function page(body, nonce, delayMs, goLabel, { enter = false, cancel = 'Abbrechen' } = {}) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${esc(nonce)}'">
<title>Release</title>
<style>
:root{color-scheme:light dark;--surface:#fff;--surface-2:#eef0f4;--fg:#1b1d22;--muted:#5d6472;--line:#dadee5;--accent:#0f6cbd;--accent-hover:#115ea3;--on-accent:#fff;--warn:#8a5300;--warn-soft:#fff4ce}
@media (prefers-color-scheme:dark){:root{--surface:#212328;--surface-2:#2a2d33;--fg:#eceef2;--muted:#a3a9b6;--line:#383c45;--accent:#479ef5;--accent-hover:#62abf5;--on-accent:#0b1520;--warn:#f7c25a;--warn-soft:#3a3020}}
html{background:transparent}
body{margin:0;padding:10px;font:13px/1.45 'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;color:var(--fg);height:100vh;box-sizing:border-box}
.card{display:flex;flex-direction:column;max-height:100%;box-sizing:border-box;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:14px 20px 16px;box-shadow:0 10px 30px rgba(0,0,0,.28)}
.brand{font-weight:600;color:var(--muted);font-size:12px;margin-bottom:6px;-webkit-app-region:drag;user-select:none}
h1{font-size:15px;margin:0 0 4px}.card p{margin:6px 0;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:140px 1fr;gap:4px 12px;margin:12px 0}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
.hash{font:11px/1.35 Cascadia Mono,Consolas,monospace}table{border-collapse:collapse;width:100%;margin:6px 0}td,th{border-bottom:1px solid var(--line);padding:3px 6px;text-align:left}.num{text-align:right}
.files{flex:1 1 auto;min-height:60px;overflow:auto;border:1px solid var(--line);border-radius:10px}.note{color:var(--warn);background:var(--warn-soft);border-radius:6px;padding:6px 10px;margin:8px 0}
.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}button{font:inherit;font-weight:500;min-height:32px;padding:5px 16px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--fg)}
button:hover{background:var(--surface-2)}button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
#go{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}#go:hover{background:var(--accent-hover)}#go[aria-disabled=true]{opacity:.45}
</style></head><body>
<div class="card"><div class="brand">Keevault</div>
${body}
<div class="actions"><button id="no" type="button">${esc(cancel)}</button><button id="go" type="button" aria-disabled="true"></button></div></div>
<script nonce="${esc(nonce)}">
(() => {
  const delay = ${Number(delayMs)};
  const go = document.getElementById('go');
  const no = document.getElementById('no');
  let ready = false, armed = false, timer = null, left = delay, tick = null;
  const label = () => { go.textContent = ready ? ${JSON.stringify(goLabel)} : ${JSON.stringify(goLabel)} + ' (' + Math.ceil(left / 1000) + ' s)'; go.setAttribute('aria-disabled', String(!ready)); };
  const stop = () => { clearTimeout(timer); clearInterval(tick); ready = false; left = delay; label(); };
  const start = () => {
    stop();
    if (!armed) return;
    tick = setInterval(() => { left = Math.max(0, left - 250); label(); }, 250);
    timer = setTimeout(() => { ready = true; clearInterval(tick); label(); }, delay);
  };
  // The waiting time runs only while the main process reports the card as shown and focused; losing the focus locks it
  // again and the time starts over on the next focus. Without that report the button stays locked (#459).
  if (window.releaseDialog.onArmed) window.releaseDialog.onArmed((on) => { armed = on === true; start(); });
  // Esc cancels (a "no" is always safe); every other key only restarts the waiting time, so Enter never confirms (#368).
  const enterConfirms = ${enter ? 'true' : 'false'};
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.isTrusted) window.releaseDialog.decide(false);
    // Enter on the focused "deny" button confirms nothing (its own activation denies).
    else if (enterConfirms && e.key === 'Enter') { if (ready && e.isTrusted && !e.repeat && document.activeElement !== no) window.releaseDialog.decide(true); }
    else start();
  }, true);
  no.addEventListener('click', () => window.releaseDialog.decide(false));
  go.addEventListener('click', (e) => { if (ready && e.isTrusted) window.releaseDialog.decide(true); });
  stop();
  window.releaseDialog.ready(document.body.innerText.length > 40 && !!document.getElementById('no'));
})();
</script></body></html>`;
}
