import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRegExport, policyFromKeys } from '../desktop/policy.js';

const ROOT = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Keevault';

test('policy: .reg export → settings and vaults', () => {
  const text = `﻿Windows Registry Editor Version 5.00

[${ROOT}]
"TenantId"="contoso.onmicrosoft.com"
"UpdateMode"="auto"
"AutoLockMinutes"=dword:0000001e
"RequirePin"=dword:00000001
"SelfUpdate"=dword:00000000
"ExtensionIds"="pbkjijhihclckeeefbepoedgdmajioip, abcdefghijklmnopabcdefghijklmnop;nicht-gueltig"
"DefaultVault"="https://KV-Team-Ops.vault.azure.net/"
"McpScope"="all"
"Unknown"="ignored"

[${ROOT}\\Vaults]
"Team Ops"="https://kv-team-ops.vault.azure.net"
"Kunde \\"A\\" – Büro"="https://kv-kunde-a.vault.azure.net/;11111111-2222-3333-4444-555555555555"
"1"="https://kv-ohne-namen.vault.azure.net/"
"Kaputt"="https://evil.example.com/"
`;
  const { settings, containers } = policyFromKeys(parseRegExport(text), ROOT);
  assert.deepEqual(settings, {
    tenantId: 'contoso.onmicrosoft.com', updateMode: 'auto', autoLockMinutes: 30, requirePin: true,
    selfUpdate: false, extensionIds: ['pbkjijhihclckeeefbepoedgdmajioip', 'abcdefghijklmnopabcdefghijklmnop'], defaultContainer: 'kv-team-ops.vault.azure.net', mcpScope: 'all',
  });
  assert.deepEqual(policyFromKeys(parseRegExport(`[${ROOT}]\n"DefaultVault"="https://evil.example.com"\n`), ROOT).settings, {}, 'default vault must be a Key Vault address');
  const byUrl = (a, b) => a.vaultUrl.localeCompare(b.vaultUrl);
  assert.deepEqual(containers.sort(byUrl), [
    { name: 'Team Ops', vaultUrl: 'https://kv-team-ops.vault.azure.net/' },
    { name: 'Kunde "A" – Büro', vaultUrl: 'https://kv-kunde-a.vault.azure.net/', tenantId: '11111111-2222-3333-4444-555555555555' },
    { name: '', vaultUrl: 'https://kv-ohne-namen.vault.azure.net/' },
  ].sort(byUrl), 'umlauts and quotes survive, foreign hosts are dropped');
});

test('policy: real reg export round trip (Windows)', { skip: process.platform !== 'win32' }, () => {
  // A scratch key outside the policy branch: the real app never reads it.
  const key = `HKCU\\Software\\KeevaultPolicyTest${process.pid}`;
  const file = path.join(os.tmpdir(), `keevault-policy-test-${process.pid}.reg`);
  try {
    execFileSync('reg', ['add', `${key}\\Vaults`, '/v', 'Tresor Größe', '/t', 'REG_SZ', '/d', 'https://kv-test.vault.azure.net', '/f'], { stdio: 'ignore' });
    execFileSync('reg', ['add', key, '/v', 'ClipboardSeconds', '/t', 'REG_DWORD', '/d', '45', '/f'], { stdio: 'ignore' });
    execFileSync('reg', ['export', key, file, '/y'], { stdio: 'ignore' });
    const root = `HKEY_CURRENT_USER\\Software\\KeevaultPolicyTest${process.pid}`;
    const { settings, containers } = policyFromKeys(parseRegExport(fs.readFileSync(file, 'utf16le')), root);
    assert.equal(settings.clipboardSeconds, 45);
    assert.deepEqual(containers, [{ name: 'Tresor Größe', vaultUrl: 'https://kv-test.vault.azure.net/' }]);
  } finally {
    execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
    fs.rmSync(file, { force: true });
  }
});
