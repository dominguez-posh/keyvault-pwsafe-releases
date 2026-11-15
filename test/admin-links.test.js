import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN_LINKS } from '../desktop/renderer/app/admin-links.js';
import { iconPaths } from '../extension/core/dom.js';

// #538: every admin center has its own symbol, drawn after its job; no vendor logo colours.
test('every admin center has its own, distinct symbol', () => {
  const ids = ['pim', 'entra', 'defender', 'purview', 'm365', 'exchange', 'teams', 'sharepoint', 'intune', 'azure'];
  assert.deepEqual(ADMIN_LINKS.map((l) => l.id), ids);
  for (const l of ADMIN_LINKS) assert.ok(iconPaths(l.icon), `${l.id}: symbol "${l.icon}" is not drawn`);
  assert.equal(new Set(ADMIN_LINKS.map((l) => l.icon)).size, ADMIN_LINKS.length, 'two centers share a symbol name');
  assert.equal(new Set(ADMIN_LINKS.map((l) => iconPaths(l.icon))).size, ADMIN_LINKS.length, 'two centers share a drawing');
  // Generic symbols (mail, cloud, …) are for entries and folders; the centers use their own "ac-" set.
  for (const l of ADMIN_LINKS) assert.match(l.icon, /^ac-/, `${l.id} uses a generic symbol`);
});

test('admin center tiles carry no vendor colours', () => {
  for (const l of ADMIN_LINKS) assert.equal(l.color, undefined, `${l.id} sets its own colour`);
  const css = readFileSync(new URL('../desktop/renderer/desktop.css', import.meta.url), 'utf8');
  const logo = /\.admin-logo \{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(logo, /color: var\(--accent\)/);
  assert.match(logo, /background: var\(--accent-soft\)/);
});
