// #487: the admin flags of a login (Microsoft admin account, Sophos login) are shown and changed only in the desktop's
// admin mode. Without it – and always from the browser – a save keeps the stored values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keepAdminFlags, keepServer } from '../extension/core/model.js';

const STORED = { id: 'e1', type: 'login', msAdmin: true, sophos: true, portals: [{ label: 'VPN', url: 'https://vpn.contoso.com' }] };

test('#487 a save without admin mode keeps the stored flags', () => {
  const next = keepAdminFlags({ ...STORED, msAdmin: false, sophos: false, portals: [] }, STORED);
  assert.equal(next.msAdmin, true);
  assert.equal(next.sophos, true);
  assert.deepEqual(next.portals, STORED.portals, 'a Sophos login keeps its portals when none come along');
});

test('#487 portals edited without admin mode stay, the flags cannot be switched on', () => {
  const edited = [{ label: 'VPN', url: 'https://vpn2.contoso.com' }];
  assert.deepEqual(keepAdminFlags({ ...STORED, portals: edited }, STORED).portals, edited);
  const plain = { id: 'e2', type: 'login', msAdmin: false, sophos: false };
  const next = keepAdminFlags({ ...plain, msAdmin: true, sophos: true, portals: [{ label: 'x', url: 'https://x' }] }, plain);
  assert.equal(next.msAdmin, false);
  assert.equal(next.sophos, false);
  assert.deepEqual(next.portals, []);
});

test('#487 a new entry without admin mode gets no admin flags; other types never', () => {
  assert.equal(keepAdminFlags({ type: 'login', msAdmin: true, sophos: true }, null).msAdmin, false);
  assert.equal(keepAdminFlags({ type: 'login', msAdmin: true, sophos: true }, null).sophos, false);
  assert.equal(keepAdminFlags({ type: 'note', msAdmin: true }, STORED).msAdmin, false);
});

test('#487 the editor shows the boxes only with ctx.adminMode and keeps the stored value otherwise', () => {
  const src = readFileSync(new URL('../extension/core/ui-item.js', import.meta.url), 'utf8');
  assert.match(src, /ctx\.adminMode \? h\('label', \{ class: 'inline admin-flag' \}, msAdmin,/);
  assert.match(src, /ctx\.adminMode \? h\('label', \{ class: 'inline admin-flag' \}, sophos,/);
  assert.match(src, /msAdmin: login && \(ctx\.adminMode \? msAdmin\.checked : !!it\.msAdmin\)/);
  assert.match(src, /sophos: login && \(ctx\.adminMode \? sophos\.checked : !!it\.sophos\)/);
  // Desktop passes admin mode; the popup never does.
  assert.match(readFileSync(new URL('../desktop/renderer/app/detail.js', import.meta.url), 'utf8'), /adminMode: adminMode\(\),/);
  assert.doesNotMatch(readFileSync(new URL('../extension/popup/popup.js', import.meta.url), 'utf8'), /adminMode/);
});

test('#487 both save paths of the main process go through the guard', () => {
  const items = readFileSync(new URL('../desktop/main/api/items.js', import.meta.url), 'utf8');
  assert.match(items, /vault\.saveItem\(containerId, await adminFlagsGuard\(containerId, item\)/);
  const browser = readFileSync(new URL('../desktop/main/browser.js', import.meta.url), 'utf8');
  assert.match(browser, /adminFlagsGuard\(containerId, item, \{ browser: true \}\)/);
  const guards = readFileSync(new URL('../desktop/main/guards.js', import.meta.url), 'utf8');
  assert.match(guards, /if \(!item \|\| \(!browser && config\.get\(\)\.adminTools === true\)\) return item;/);
});

// Lucas, 2026-11-10: the type "Server/Gerät" only in admin mode; outside it existing servers are read-only as servers.
const SERVER = { id: 's1', type: 'server', title: 'DC01', username: 'adm', password: 'pw', server: { kind: 'windows', host: 'dc01.contoso.local' } };

test('#487 a stored server keeps type, connection and account outside admin mode; title and favourite change', () => {
  const next = keepServer({ ...SERVER, type: 'login', title: 'DC01 neu', favorite: true, username: 'x', password: 'y', server: { kind: 'linux', host: 'evil' } }, SERVER);
  assert.equal(next.type, 'server');
  assert.deepEqual(next.server, SERVER.server);
  assert.equal(next.username, 'adm');
  assert.equal(next.password, 'pw');
  assert.equal(next.title, 'DC01 neu');
  assert.equal(next.favorite, true);
});

test('#487 a new server, or an entry turned into one, is refused outside admin mode; other entries pass', () => {
  assert.throws(() => keepServer({ type: 'server', title: 'neu', server: { kind: 'windows', host: 'x' } }, null));
  assert.throws(() => keepServer({ id: 'e1', type: 'server', server: { kind: 'windows', host: 'x' } }, { id: 'e1', type: 'login' }));
  const login = { id: 'e1', type: 'login', username: 'u' };
  assert.deepEqual(keepServer(login, login), login);
});

test('#487 the guard applies the server rule; edit and duplicate of a server only in admin mode', () => {
  const guards = readFileSync(new URL('../desktop/main/guards.js', import.meta.url), 'utf8');
  assert.match(guards, /return keepAdminFlags\(keepServer\(item, stored\), stored\);/);
  const detail = readFileSync(new URL('../desktop/renderer/app/detail.js', import.meta.url), 'utf8');
  assert.match(detail, /const asServer = item\.type !== 'server' \|\| adminMode\(\);/);
  assert.match(detail, /canWrite && asServer \? \{ action: 'edit'/);
  assert.match(detail, /canWrite && asServer \? \{ action: 'duplicate'/);
  const actions = readFileSync(new URL('../desktop/renderer/app/item-actions.js', import.meta.url), 'utf8');
  assert.match(actions, /label: t\('Bearbeiten'\), disabled: !canWrite \|\| !asServer/);
  assert.match(actions, /label: t\('Duplizieren'\), disabled: !canWrite \|\| !asServer/);
  // The type list of the editor offers "server" for a new entry only with ctx.devices (admin mode).
  assert.match(readFileSync(new URL('../extension/core/ui-item.js', import.meta.url), 'utf8'), /filter\(\(\[k\]\) => k !== 'server' \|\| ctx\.devices \|\| it\.type === 'server'\)/);
});

test('#487 review: the import outside admin mode sets no admin flags', () => {
  const items = readFileSync(new URL('../desktop/main/api/items.js', import.meta.url), 'utf8');
  assert.match(items, /if \(config\.get\(\)\.adminTools !== true\) items = items\.map\(\(i\) => keepAdminFlags\(i, null\)\);/);
  const imported = keepAdminFlags({ type: 'login', title: 'x', msAdmin: true, sophos: true, portals: [{ label: 'VPN', url: 'https://vpn' }] }, null);
  assert.equal(imported.msAdmin, false);
  assert.equal(imported.sophos, false);
  assert.deepEqual(imported.portals, []);
});

test('#487 review: the guard reads the stored entry only in the target vault and stops on a read error', () => {
  const guards = readFileSync(new URL('../desktop/main/guards.js', import.meta.url), 'utf8');
  assert.match(guards, /const stored = item\.id \? await vault\.getItem\(containerId, item\.id, \{ fresh: true \}\) : null;/);
  assert.doesNotMatch(guards, /item\.containerId \|\| containerId/);
  assert.doesNotMatch(guards.slice(guards.indexOf('adminFlagsGuard')), /\.catch\(\(\) => null\)/);
});
