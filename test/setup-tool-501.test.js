// Setup tool (#501): the PowerShell engine against an ARM/Graph stub (plan, dry run, idempotence, missing rights,
// export/import, no secrets in the documentation) in Windows PowerShell 5.1 and PowerShell 7, and the wizard's local
// server (start token, session cookie, Host check, API header, dry run before run). Windows only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'setup-tool', 'tests');
const shells = process.platform !== 'win32' ? [] : ['powershell.exe', 'pwsh'].filter((s) =>
  spawnSync(s, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0);
const args = (file) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, file)];

for (const shell of shells) {
  const out = spawnSync(shell, args('Run-Tests.ps1'), { encoding: 'utf8', timeout: 240_000 });
  const lines = (out.stdout || '').split(/\r?\n/).filter((l) => /^(PASS|FAIL) /.test(l));
  test(`setup tool (${shell}): all scenarios ran`, () => {
    assert.ok(lines.length >= 10, `zu wenige Szenarien: ${out.stdout}\n${out.stderr}`);
  });
  for (const line of lines) {
    const name = line.slice(5).split(' -- ')[0];
    test(`setup tool (${shell}): ${name}`, () => assert.ok(line.startsWith('PASS '), line));
  }
}

// Part c: the Terraform export passes `terraform validate` (azurerm + azuread). Skipped with a reason when Terraform is
// not installed or the providers cannot be downloaded; providers are cached in the temp folder between runs.
const terraform = spawnSync('terraform', ['version'], { encoding: 'utf8' }).status === 0;
test('setup tool: Terraform export passes terraform validate', { skip: (!shells.length && 'PowerShell fehlt') || (!terraform && 'terraform nicht installiert – validate übersprungen'), timeout: 900_000 }, (t) => {
  const out = mkdtempSync(join(tmpdir(), 'ks-tf-'));
  try {
    const gen = spawnSync(shells[0], [...args('Export-Terraform.ps1'), '-Out', out], { encoding: 'utf8', timeout: 120_000 });
    assert.match(gen.stdout, /TF_WRITTEN/, gen.stdout + gen.stderr);
    const cache = join(tmpdir(), 'keevault-tf-plugin-cache');
    mkdirSync(cache, { recursive: true });
    const env = { ...process.env, TF_PLUGIN_CACHE_DIR: cache, TF_IN_AUTOMATION: '1', CHECKPOINT_DISABLE: '1' };
    for (const variant of ['full', 'data']) {
      const cwd = join(out, variant);
      const tf = readFileSync(join(cwd, 'main.tf'), 'utf8');
      assert.doesNotMatch(tf, /00000000-0000-0000-0000-00000000(aaaa|bbbb)/, 'keine Tenant- oder Subscription-ID im Code');
      const init = spawnSync('terraform', ['init', '-backend=false', '-input=false', '-no-color'], { cwd, env, encoding: 'utf8', timeout: 600_000 });
      if (init.status !== 0) { t.skip('terraform init fehlgeschlagen (Netz/Registry?), validate übersprungen: ' + (init.stderr || init.stdout).split('\n').find((l) => l.trim())); return; }
      const v = spawnSync('terraform', ['validate', '-json', '-no-color'], { cwd, env, encoding: 'utf8', timeout: 120_000 });
      const result = JSON.parse(v.stdout);
      assert.equal(result.valid, true, `${variant}: ${v.stdout}`);
      assert.equal(result.warning_count, 0, `${variant}: Warnungen ${JSON.stringify(result.diagnostics)}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

function http(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('setup tool: wizard server only answers its own window and runs only after a dry run', { skip: !shells.length && 'PowerShell fehlt' }, async () => {
  const child = spawn(shells[0], args('Start-TestUi.ps1'), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('kein Start: ' + stdout + stderr)), 60_000);
      child.stdout.on('data', (c) => {
        stdout += c;
        const m = stdout.match(/KEEVAULT_SETUP_URL (\S+)/);
        if (m) { clearTimeout(timer); resolve(new URL(m[1])); }
      });
    });
    const port = Number(url.port);
    const token = url.searchParams.get('t');
    assert.match(token, /^[0-9a-f]{64}$/);

    assert.equal((await http(port, '/')).status, 403, 'ohne Sitzung keine Seite');
    assert.equal((await http(port, '/start?t=' + '0'.repeat(64))).status, 403, 'falscher Startlink');
    const rebind = await http(port, '/start?t=' + token, { headers: { Host: `evil.example:${port}` } });
    assert.ok([400, 403].includes(rebind.status), 'fremder Host abgelehnt: ' + rebind.status);

    const start = await http(port, '/start?t=' + token);
    assert.equal(start.status, 302);
    const setCookie = String(start.headers['set-cookie']);
    assert.match(setCookie, /ks=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict/);
    const cookie = setCookie.split(';')[0];
    assert.equal((await http(port, '/start?t=' + token)).status, 403, 'Startlink nur einmal');

    const page = await http(port, '/', { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.match(page.body, /Keevault/);
    const css = await http(port, '/extension/styles/app.css', { headers: { Cookie: cookie } });
    assert.equal(css.status, 200, 'Keevault-Styles werden ausgeliefert');
    assert.match(css.body, /--accent/);
    for (const path of ['/%2e%2e/KeevaultSetup/KeevaultSetup.psm1', '/KeevaultSetup/KeevaultSetup.psm1', '/ui/app.js/../../tests/FakeAzure.ps1']) {
      const r = await http(port, path, { headers: { Cookie: cookie } });
      assert.ok([400, 403, 404].includes(r.status) && !/function /.test(r.body), `nur freigegebene Dateien: ${path} ${r.status}`);
    }

    const json = { 'Content-Type': 'application/json', Cookie: cookie, 'X-Keevault-Setup': '1' };
    const call = async (name, payload = {}) => {
      const r = await http(port, '/api/' + name, { method: 'POST', headers: json, body: JSON.stringify(payload) });
      return { status: r.status, data: JSON.parse(r.body) };
    };
    assert.equal((await http(port, '/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' })).status, 403, 'ohne Kopfzeile keine API');
    assert.equal((await http(port, '/api/state', { headers: json })).status, 403, 'API nur per POST');

    const { data: state } = await call('state');
    assert.equal(state.context.SignedIn, true);
    const plan = { ...state.defaults, vaults: [{ name: 'kv-team-a', displayName: 'Team A' }] };
    const bad = await call('validate', { plan: { ...plan, extra: 1 } });
    assert.equal(bad.data.valid, false);

    assert.equal((await call('run', { plan, hash: '0'.repeat(64) })).status, 400, 'Ausführen ohne passenden Probelauf');
    const dry = await call('dryrun', { plan });
    assert.equal(dry.status, 200, JSON.stringify(dry.data));
    assert.ok(dry.data.result.Steps.some((s) => s.Status === 'planned'));
    const run = await call('run', { plan, hash: dry.data.result.PlanHash });
    assert.equal(run.status, 200, JSON.stringify(run.data));
    assert.ok(run.data.result.Steps.filter((s) => s.Kind === 'auto').every((s) => s.Status === 'done'), JSON.stringify(run.data.result.Steps.map((s) => [s.Id, s.Status, s.Detail])));
    const report = await call('report');
    assert.match(report.data.markdown, /^# Keevault-Einrichtung/);
    assert.match(report.data.markdown, /\n# Notfallhandbuch\n/);
    const html = await call('report', { format: 'html' });
    assert.equal(html.data.name, 'Keevault-Einrichtung.html');
    assert.match(html.data.text, /^<!doctype html>[\s\S]*Notfallhandbuch/);
    assert.doesNotMatch(html.data.text, /<script/i);
    const docx = await call('report', { format: 'docx' });
    assert.equal(docx.data.name, 'Keevault-Einrichtung.docx');
    assert.equal(Buffer.from(docx.data.base64, 'base64').subarray(0, 2).toString(), 'PK');
    assert.equal((await call('report', { format: 'exe' })).status, 400, 'nur md, html, docx');

    // Language: the window and the engine texts switch; a report keeps the language of its run.
    const i18n = await http(port, '/i18n.js', { headers: { Cookie: cookie } });
    assert.equal(i18n.status, 200);
    assert.match(i18n.body, /emergency handbook/);
    assert.equal((await call('language', { language: 'fr' })).status, 400);
    const en = await call('language', { language: 'en' });
    assert.equal(en.data.language, 'en');
    assert.equal(en.data.stepLabels.vaults, 'Create Key Vaults with RBAC');
    assert.deepEqual(en.data.questions.map((q) => q.id), ['breakGlassFidoLocation', 'breakGlassAccess', 'recoveryKeyLocation', 'contactOwner', 'contactEmergency']);
    assert.match((await call('report')).data.markdown, /^# Keevault-Einrichtung/, 'Doku in der Sprache ihres Laufs');
    assert.equal((await call('dryrun', { plan })).status, 200);
    const enReport = await call('report');
    assert.equal(enReport.data.name, 'Keevault-Setup.md');
    assert.match(enReport.data.markdown, /^# Keevault setup[\s\S]*# Emergency handbook/);
    await call('language', { language: 'de' });
    const tfExport = await call('terraform', { plan });
    assert.equal(tfExport.status, 200, JSON.stringify(tfExport.data));
    assert.match(tfExport.data.text, /resource "azurerm_key_vault" "kv_team_a"/);
    assert.equal((await call('terraform', { plan: { ...plan, extra: 1 } })).status, 400);
    // Part d: the policy package as ZIP; without a choice it is refused.
    assert.equal(state.defaults.devicePolicy.scope, 'machine');
    assert.equal((await call('devicepolicy', { plan })).status, 400, 'ohne Auswahl kein Paket');
    const zip = await call('devicepolicy', { plan: { ...plan, devicePolicy: { ...plan.devicePolicy, requirePin: true, extensionBrowsers: ['edge'] } } });
    assert.equal(zip.status, 200, JSON.stringify(zip.data));
    const bytes = Buffer.from(zip.data.base64, 'base64');
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004', 'ZIP');
    for (const name of ['GPO/New-KeevaultGpo.ps1', 'Intune/Keevault-Richtlinien.intune.json', 'Intune/Keevault-Browser-Richtlinie.ps1', 'Anleitung.md']) {
      assert.ok(bytes.includes(Buffer.from(name)), `${name} im ZIP`);
    }
    const exported = await call('export', { plan, portable: true });
    assert.equal(JSON.parse(exported.data.json).target.subscriptionId, '');

    // #516: "Keevault im Tenant freischalten" is there, disabled, "(demnächst verfügbar)" / "(coming soon)", no action.
    const consent = page.body.match(/<button id="tenant-consent"[^>]*>([^<]*)<\/button>/);
    assert.ok(consent, 'Knopf „Keevault im Tenant freischalten“ fehlt');
    assert.match(consent[0], /\sdisabled[\s>]/, 'Knopf ist nicht deaktiviert');
    assert.equal(consent[1], 'Keevault im Tenant freischalten (demnächst verfügbar)');
    assert.match(i18n.body, /tenantConsent: 'Keevault im Tenant freischalten \(demnächst verfügbar\)'/);
    assert.match(i18n.body, /tenantConsent: 'Enable Keevault in the tenant \(coming soon\)'/);
    const appJs = await http(port, '/app.js', { headers: { Cookie: cookie } });
    assert.doesNotMatch(appJs.body, /tenant-consent/, 'der Platzhalter hat keine Funktion');
    // Part e: drift and framework check over the API, read-only (the WRITES count below stays that of the one run).
    const driftR = await call('drift', { plan });
    assert.equal(driftR.status, 200, JSON.stringify(driftR.data));
    assert.equal(driftR.data.result.Summary.missing, 0, JSON.stringify(driftR.data.result.Items.filter((i) => i.Status !== 'ok')));
    assert.equal(driftR.data.result.Plan, undefined, 'Plan nicht zurück ins Fenster');
    const cc = await call('compliance', { plan });
    assert.equal(cc.status, 200, JSON.stringify(cc.data));
    // Decision Lucas 2026-11-11: CISA in full, CIS only as an unverified mapping.
    assert.ok(cc.data.result.Controls.every((c) => /^(geprüft gegen Kontrolle MS\.AAD\.|Keevault-Empfehlung)/.test(c.Reference)), JSON.stringify(cc.data.result.Controls.map((c) => c.Reference)));
    assert.ok(cc.data.result.Controls.filter((c) => /CIS /.test(c.Reference)).every((c) => /ungeprüfte Zuordnung: CIS /.test(c.Reference)));
    const checkMd = await call('checkreport', { format: 'md' });
    assert.match(checkMd.data.text, /^# Keevault – Prüfbericht/);
    assert.equal((await call('checkreport', { format: 'exe' })).status, 400);

    await call('quit');
    await exited;
    assert.match(stdout, /WRITES 12/, 'genau ein Lauf geschrieben: ' + stdout);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

// Part d: the device policies write exactly what the app reads (desktop/policy.js) and, for the browser extension, the
// fixed values of desktop/machine-setup.js, so the app recognises the policy as its own (#455, #494).
test('setup tool: device policy values match the app (policy.js, machine-setup.js)', { skip: !shells.length && 'PowerShell fehlt' }, async () => {
  const { EXTENSION_ID, UPDATE_URL, EARLY_ACCESS_FEED, settingsValue } = await import('../desktop/machine-setup.js');
  const policy = readFileSync(join(dir, '..', '..', 'desktop', 'policy.js'), 'utf8');
  const ps = [
    `Import-Module '${join(dir, '..', 'KeevaultSetup', 'KeevaultSetup.psd1')}' -Force`,
    '$p = New-KeevaultSetupPlan -Vault kv-team-a',
    "$d = $p.devicePolicy; $d.requirePin = $true; $d.updateChannel = 'stable'; $d.updateMode = 'ask'; $d.browserIntegration = $true; $d.windowsProvider = $true",
    "$d.tenantId = 'contoso.onmicrosoft.com'; $d.clientId = '00000000-0000-0000-0000-0000000000cc'; $d.connectVaults = $true; $d.extensionBrowsers = @('edge', 'chrome')",
    '$m = Get-Module KeevaultSetup',
    "$out = [ordered]@{ values = @(& $m { param($x) Get-KsDevicePolicyValues $x } $p | ForEach-Object { @{ key = $_.Key; name = $_.Name; value = [string] $_.Value } }) }",
    "foreach ($c in 'stable', 'beta') { $out[$c] = & $m { param($c) Get-KsExtension @{ updateChannel = $c; extensionSource = 'github' } } $c }",
    '$out | ConvertTo-Json -Depth 6 -Compress',
  ].join('; ');
  const r = spawnSync(shells[0], ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60_000 });
  const out = JSON.parse(r.stdout);
  const app = out.values.filter((x) => x.key === 'SOFTWARE\\Policies\\Keevault').map((v) => v.name);
  assert.deepEqual(app, ['RequirePin', 'UpdateChannel', 'UpdateMode', 'BrowserIntegration', 'WindowsProvider', 'TenantId', 'ClientId']);
  for (const name of app) assert.ok(policy.includes(`${name}: { setting:`), `${name} liest die App nicht`);
  assert.ok(out.values.some((v) => v.key === 'SOFTWARE\\Policies\\Keevault\\Vaults' && v.value === 'https://kv-team-a.vault.azure.net/'), 'Tresor unter …\\Keevault\\Vaults');
  for (const [channel, feed] of [['stable', UPDATE_URL], ['beta', EARLY_ACCESS_FEED]]) {
    assert.equal(out[channel].Id, EXTENSION_ID);
    assert.equal(out[channel].Forcelist, `${EXTENSION_ID};${feed}`, `Forcelist ${channel}`);
    assert.equal(out[channel].Settings, settingsValue(feed), `ExtensionSettings ${channel} wie machine-setup.js`);
  }
  assert.deepEqual(out.stable.OwnSettings, [UPDATE_URL, EARLY_ACCESS_FEED].map(settingsValue));
});
