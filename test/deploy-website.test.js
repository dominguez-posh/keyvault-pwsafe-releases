import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprint, hostKeys, websiteFiles } from '../scripts/deploy-website.mjs';

test('website upload: host key pinned in ssh-keygen format', () => {
  assert.ok(hostKeys.length >= 1);
  for (const k of hostKeys) assert.match(k, /^SHA256:[A-Za-z0-9+/]{43}$/);
  const key = Buffer.from('host key blob');
  assert.equal(fingerprint(key), `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`);
  assert.ok(!hostKeys.includes(fingerprint(key)), 'an unknown server key is refused');
});

test('website upload: every file below htdocs, with forward slashes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-site-'));
  try {
    mkdirSync(join(dir, 'wissen'));
    writeFileSync(join(dir, 'index.html'), 'x');
    writeFileSync(join(dir, 'wissen', 'a.html'), 'y');
    assert.deepEqual(websiteFiles(dir).sort(), ['index.html', 'wissen/a.html']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Prod approval starts the website upload; both stay out of the public export', () => {
  const promote = readFileSync(new URL('../.github/workflows/promote-production.yml', import.meta.url), 'utf8');
  assert.match(promote, /gh workflow run website\.yml/);
  const site = readFileSync(new URL('../.github/workflows/website.yml', import.meta.url), 'utf8');
  assert.match(site, /node scripts\/deploy-website\.mjs/);
  assert.match(site, /secrets\.KEEVAULT_SFTP_PASSWORD/);
  const exp = readFileSync(new URL('../scripts/export-public.mjs', import.meta.url), 'utf8');
  assert.match(exp, /deploy-website/);
  assert.match(exp, /\(early-access\|website\)\\\.yml/);
});
