// Emergency signature when the app does not start (docs/RELEASE.md, #378): a page on http://localhost asks a hardware
// key for the release signature. It holds no key and cannot sign anything alone – without the touch of an embedded
// hardware key (alg es256 in desktop/update-verify.js) it writes nothing. Not usable before the hardware keys are
// registered and embedded (phase 2).
//
//   node scripts/emergency-sign.mjs <release-dir> <credential-id> [<credential-id> …]
//   → open the printed address in a browser, touch the key; writes <release-dir>/latest.yml.sig2
//
// The origin must be exactly http://localhost (the app's passkey window uses it), so the server needs port 80.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UPDATE_KEYS, encodeAssertion, parseManifest, releaseChallenge, verifyManifest } from '../desktop/update-verify.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// JSON inside a script block: no </script>, no comment openers.
const inScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const page = (info) => `<!doctype html><meta charset="utf-8"><title>Release signieren (Notfall)</title>
<body style="font:15px system-ui;max-width:640px;margin:2em auto">
<h1>Release ${esc(info.version)} signieren</h1>
<p>Manifest SHA-512:<br><code style="word-break:break-all">${esc(info.sha512)}</code></p>
<p>Nur berühren, wenn du das Signieren gerade selbst gestartet hast.</p>
<button id="go" style="font:inherit;padding:8px 18px">Sicherheitsschlüssel berühren</button> <span id="out"></span>
<script>
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
document.getElementById('go').onclick = async () => {
  const out = document.getElementById('out');
  try {
    const a = await navigator.credentials.get({ publicKey: { rpId: 'localhost', challenge: unb64(${inScript(info.challenge)}), userVerification: 'required', timeout: 120000,
      allowCredentials: ${inScript(info.credentialIds)}.map((id) => ({ type: 'public-key', id: unb64(id) })) } });
    const r = await fetch('/sign', { method: 'POST', body: JSON.stringify({ authData: b64(a.response.authenticatorData), clientDataJSON: b64(a.response.clientDataJSON), signature: b64(a.response.signature) }) });
    out.textContent = r.ok ? 'Fertig: latest.yml.sig2 geschrieben. Du kannst das Fenster schließen.' : 'Abgelehnt: ' + await r.text();
  } catch (e) { out.textContent = 'Fehler: ' + e.message; }
};
</script>`;

/** The server without listening yet (tests drive it directly). → http.Server */
export function createEmergencyServer({ dir, credentialIds, keys = UPDATE_KEYS, origin }) {
  const manifest = fs.readFileSync(path.join(dir, 'latest.yml')); // read once: these bytes are signed
  const parsed = parseManifest(manifest.toString('utf8'));
  const version = parsed.version || '?';
  // The installer must be the one the manifest names (the page shows hashes the person cannot compare by eye).
  const installer = path.join(dir, path.basename(parsed.url || ''));
  if (!parsed.url || !fs.existsSync(installer) || crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64') !== parsed.sha512) throw new Error('Der Installer fehlt oder passt nicht zu sha512 in latest.yml – nichts wird signiert.');
  const info = { version, sha512: crypto.createHash('sha512').update(manifest).digest('hex'), challenge: releaseChallenge(manifest), credentialIds };
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page(info));
    }
    if (req.method === 'POST' && req.url === '/sign') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 20_000) req.destroy(); });
      req.on('end', () => {
        try {
          const a = JSON.parse(body);
          const raw = (x) => Buffer.from(String(x), 'base64');
          const sig = encodeAssertion({ authData: raw(a.authData), clientDataJSON: raw(a.clientDataJSON), signature: raw(a.signature) });
          if (!verifyManifest(manifest, sig, keys.filter((k) => k.alg === 'es256'), origin)) throw new Error('Die Antwort passt zu keinem eingebetteten Hardware-Schlüssel und diesem Release.');
          fs.writeFileSync(path.join(dir, 'latest.yml.sig2'), sig);
          res.writeHead(200).end('ok');
        } catch (e) {
          res.writeHead(400).end(e.message);
        }
      });
      return undefined;
    }
    res.writeHead(404).end();
    return undefined;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, ...credentialIds] = process.argv.slice(2);
  if (!dir || !credentialIds.length) throw new Error('Aufruf: node scripts/emergency-sign.mjs <release-ordner> <credential-id> […]');
  if (!UPDATE_KEYS.some((k) => k.alg === 'es256')) throw new Error('Kein Hardware-Schlüssel (es256) in UPDATE_KEYS eingebettet – der Notfallweg gilt erst ab Phase 2.');
  const server = createEmergencyServer({ dir, credentialIds });
  server.listen(80, '127.0.0.1', () => console.log('Öffne http://localhost/ im Browser und berühre den Sicherheitsschlüssel. Ende mit Strg+C.'));
}
