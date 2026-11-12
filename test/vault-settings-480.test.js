// #480: vault settings in the metadata secret pws-container – validation, Verwalter rule, unknown fields, old clients.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './fixtures/fake-keyvault.js';
import {
  cleanVaultSettings, mergeSettings, readVaultSettings, writeVaultSettings, storedVaultSettings, orderFolders, missingRequired, requireFields,
  passwordAgeNotice, templateFromItem, itemFromTemplate, cleanTemplate, TEMPLATES_MAX,
  DESCRIPTION_MAX, VAULT_COLORS, VAULT_ICONS,
} from '../extension/core/vault-settings.js';
import { renameInVault } from '../extension/core/session-meta.js';

const cid = 'kv-team.vault.azure.net';

export async function withAccess(access) {
  const s = await setup();
  const stored = await s.session.store.get('containers');
  stored[0].access = access;
  await s.session.store.set('containers', stored);
  return s;
}
const MANAGER = { read: true, write: true, manage: true, admin: false };
const MEMBER = { read: true, write: true, manage: false, admin: false };
const meta = (kv) => JSON.parse(kv.secrets.get('pws-container').at(-1).value);

test('look: only the fixed palette and symbols, description cleaned and capped, folder order normalised', () => {
  const s = cleanVaultSettings({ look: { color: 'blue', icon: 'server', description: '‮abc\u0000 def', folderOrder: ['B', ' A/x ', 'B', 7, '<b>'] } });
  assert.equal(s.look.color, 'blue');
  assert.equal(s.look.icon, 'server');
  assert.equal(s.look.description, 'abc def');
  assert.deepEqual(s.look.folderOrder, ['B', 'A/x', '<b>']);
  const bad = cleanVaultSettings({ look: { color: '#ff0000; background:url(x)', icon: '<svg onload=x>', description: 'x'.repeat(500), folderOrder: 'A' } });
  assert.equal(bad.look.color, '');
  for (const gone of ['red', 'amber', 'yellow']) assert.equal(cleanVaultSettings({ look: { color: gone } }).look.color, '', `${gone} left the palette (Lucas): stored values read as no colour`);
  assert.equal(bad.look.icon, '');
  assert.equal(bad.look.description.length, DESCRIPTION_MAX);
  assert.deepEqual(bad.look.folderOrder, []);
  assert.ok(VAULT_COLORS.length === 4 && !VAULT_COLORS.includes('red') && VAULT_ICONS.includes('vault'));
});

test('garbage of any shape gives the defaults, never a throw', () => {
  for (const raw of [null, 'x', 42, [], { look: [], contact: 'a', rules: 1, protect: null }, { look: { folderOrder: [null, {}, []] } }]) {
    const s = cleanVaultSettings(raw);
    assert.equal(s.look.color, '');
    assert.equal(s.protect.pinCopy, false);
    assert.equal(s.protect.private, 'allow');
    assert.deepEqual(s.rules.templates, []);
  }
});

test('folders sort by the vault order first, the rest alphabetically', () => {
  assert.deepEqual(orderFolders(['a', 'c', 'b', 'd'], { look: { folderOrder: ['d', 'b'] } }), ['d', 'b', 'a', 'c']);
  assert.deepEqual(orderFolders(['b', 'a'], null), ['a', 'b']);
});

test('merge: only the given groups change; unknown groups and unknown fields in a group stay', () => {
  const stored = { v: 1, look: { color: 'blue', badge: 'future' }, future: { x: 1 }, contact: { name: 'Alt' } };
  const next = mergeSettings(stored, { look: { color: 'green', icon: 'nope' } });
  assert.equal(next.look.color, 'green');
  assert.equal(next.look.icon, '');
  assert.equal(next.look.badge, 'future');
  assert.deepEqual(next.future, { x: 1 });
  assert.deepEqual(next.contact, { name: 'Alt' }, 'a group not in the patch is left as it was');
  assert.equal(mergeSettings({ v: 3 }, {}).v, 3, 'a newer version number stays');
});

test('a Verwalter writes the settings into pws-container; name, logo and unknown top-level fields stay', async () => {
  const { kv, session } = await withAccess(MANAGER);
  await session.writeContainerMeta(session.kv(await session.container(cid)), { name: 'Team', future: { a: 1 } });
  const saved = await writeVaultSettings(session, cid, { look: { color: 'violet', icon: 'key', description: 'Team-Zugänge', folderOrder: ['Server'] } });
  assert.equal(saved.look.color, 'violet');
  const m = meta(kv);
  assert.equal(m.format, 'kvpwsafe-container');
  assert.equal(m.name, 'Team');
  assert.deepEqual(m.future, { a: 1 });
  assert.equal(m.settings.v, 1);
  assert.equal(m.settings.look.description, 'Team-Zugänge');
  assert.equal((await readVaultSettings(session, cid, { fresh: true })).look.icon, 'key');
  assert.equal((await storedVaultSettings(session))[cid].look.color, 'violet', 'kept for the vault list and the extension');
});

test('a member without Verwalter rights is refused in the session and nothing is written', async () => {
  const { kv, session } = await withAccess(MEMBER);
  const before = kv.secrets.get('pws-container')?.length ?? 0;
  await assert.rejects(writeVaultSettings(session, cid, { look: { color: 'blue' } }), /Verwaltungsrechte/);
  assert.equal(kv.secrets.get('pws-container')?.length ?? 0, before);
});

test('an old client that renames the vault keeps the settings (read, merge, write)', async () => {
  const { kv, session } = await withAccess(MANAGER);
  await writeVaultSettings(session, cid, { look: { color: 'green' } });
  await renameInVault(session, cid, 'Neu'); // the same path every client before #480 takes
  assert.equal(meta(kv).name, 'Neu');
  assert.equal(meta(kv).settings.look.color, 'green');
});

test('values set directly in Azure by an insider are cleaned on reading', async () => {
  const { session } = await withAccess(MEMBER);
  const kvc = session.kv(await session.container(cid));
  await session.writeContainerMeta(kvc, { settings: { v: 9, look: { color: 'javascript:x', description: '​hi' }, protect: { pinCopy: 'yes', noExport: 1 } } });
  const s = await readVaultSettings(session, cid, { fresh: true });
  assert.equal(s.look.color, '');
  assert.equal(s.look.description, 'hi');
  assert.equal(s.protect.pinCopy, false, 'only a real true counts');
  assert.equal(s.protect.noExport, false);
});

test('the index refresh remembers the settings of the vault (for the list and the extension)', async () => {
  const { session } = await withAccess(MANAGER);
  const kvc = session.kv(await session.container(cid));
  await session.writeContainerMeta(kvc, { name: 'Team', settings: { look: { color: 'violet' } } });
  await session.refreshIndex();
  for (let i = 0; i < 20 && !(await storedVaultSettings(session))[cid]; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await storedVaultSettings(session))[cid]?.look.color, 'violet');
});

test('contact: name cleaned, only a real mail address or UPN; a Verwalter gets a clear refusal for a wrong one', async () => {
  const s = cleanVaultSettings({ contact: { name: '\u202EMax\u0000 Muster', email: 'max.muster@contoso.onmicrosoft.com' } });
  assert.deepEqual(s.contact, { name: 'Max Muster', email: 'max.muster@contoso.onmicrosoft.com' });
  for (const email of ['javascript:alert(1)', 'a@b', 'x@y.z<script>', 'mailto:a@b.de', 'a b@c.de', `${'a'.repeat(250)}@b.de`, 42]) {
    assert.equal(cleanVaultSettings({ contact: { email } }).contact.email, '', String(email));
  }
  const { session } = await withAccess(MANAGER);
  await assert.rejects(writeVaultSettings(session, cid, { contact: { name: 'Max', email: 'kein-mail' } }), /E-Mail/);
  const saved = await writeVaultSettings(session, cid, { contact: { name: 'Max', email: 'max@example.test' } });
  assert.equal(saved.contact.email, 'max@example.test');
  assert.equal((await storedVaultSettings(session))[cid].contact.name, 'Max', 'kept for "Kein Zugriff", when the vault cannot be read');
});

test('rules: generator defaults never weaker than the minimum, required fields only from the list, age in range', () => {
  const ok = cleanVaultSettings({ rules: { generator: { length: 24, upper: true, lower: true, digits: false, symbols: true }, maxAgeMonths: 12 } }).rules;
  assert.deepEqual(ok.generator, { length: 24, lower: true, upper: true, digits: false, symbols: true });
  assert.equal(ok.maxAgeMonths, 12);
  for (const generator of [{ length: 4, lower: true }, { length: 20 }, { length: '20', lower: true }, { length: 500, lower: true }, 'x']) {
    assert.equal(cleanVaultSettings({ rules: { generator } }).rules.generator, null, JSON.stringify(generator));
  }
  assert.equal(cleanVaultSettings({ rules: { maxAgeMonths: -1 } }).rules.maxAgeMonths, 0);
  assert.equal(cleanVaultSettings({ rules: { maxAgeMonths: 1.5 } }).rules.maxAgeMonths, 0);
  const req = cleanVaultSettings({ rules: { required: { login: ['username', 'password', 'evil', '__proto__'], note: 'notes', bogus: ['x'] } } }).rules.required;
  assert.deepEqual(req, { login: ['username', 'password'] });
});

test('rules: a save without a required field is refused with the field names', () => {
  const settings = cleanVaultSettings({ rules: { required: { login: ['username', 'urls'], card: ['card.number'], certificate: ['cert'] } } });
  assert.deepEqual(missingRequired({ type: 'login', username: ' ', urls: [] }, settings), ['username', 'urls']);
  assert.deepEqual(missingRequired({ type: 'login', username: 'a', urls: ['https://x.de'] }, settings), []);
  assert.deepEqual(missingRequired({ type: 'card', card: { number: '' } }, settings), ['card.number']);
  assert.deepEqual(missingRequired({ type: 'certificate', cert: { data: '' } }, settings), ['cert']);
  assert.throws(() => requireFields({ type: 'login' }, settings), /Pflichtfelder.*Benutzername.*Website/);
  assert.doesNotThrow(() => requireFields({ type: 'note' }, settings));
});

test('rules: age notice from the date the password changed', () => {
  const settings = cleanVaultSettings({ rules: { maxAgeMonths: 6 } });
  const now = Date.parse('2026-11-10T00:00:00Z');
  assert.equal(passwordAgeNotice('2026-01-01T00:00:00Z', settings, now), 10);
  assert.equal(passwordAgeNotice('2026-09-01T00:00:00Z', settings, now), 0);
  assert.equal(passwordAgeNotice('', settings, now), 0);
  assert.equal(passwordAgeNotice('2020-01-01', cleanVaultSettings({}), now), 0, 'no rule, no notice');
});

test('templates: no secret survives, only http(s) addresses, at most the limit', () => {
  const tpl = templateFromItem({
    type: 'login', title: 'Kunde', username: 'admin', password: 'geheim', totp: 'otpauth://x', notes: 'n', folder: 'Kunden',
    urls: ['portal.example.test', 'javascript:alert(1)', 'file:///c:/x'],
    card: { number: '4111', cvc: '1', pin: '2' },
    fields: [{ name: 'Mandant', value: 'contoso' }, { name: 'PIN', value: '1234', type: 'hidden' }, { name: 'OTP', value: 'abc', type: 'totp' },
      { name: 'Datei', value: 'QUJD', type: 'file' }, { name: 'Alt', value: 'x', hidden: true }],
  }, 'Kundenzugang');
  assert.equal(tpl.name, 'Kundenzugang');
  assert.equal('password' in tpl, false);
  assert.equal('totp' in tpl, false);
  assert.equal('card' in tpl, false);
  assert.deepEqual(tpl.urls, ['https://portal.example.test/']);
  assert.deepEqual(tpl.fields.map((f) => [f.name, f.value]), [['Mandant', 'contoso'], ['PIN', ''], ['OTP', ''], ['Alt', '']]);
  assert.ok(!JSON.stringify(tpl).includes('geheim') && !JSON.stringify(tpl).includes('1234') && !JSON.stringify(tpl).includes('QUJD'));
  const many = cleanVaultSettings({ rules: { templates: Array.from({ length: 30 }, (_, i) => ({ name: `T${i}`, type: 'note', id: 'same' })) } }).rules.templates;
  assert.equal(many.length, TEMPLATES_MAX);
  assert.equal(new Set(many.map((x) => x.id)).size, many.length, 'ids are unique');
  assert.equal(cleanTemplate({ name: 'x', type: 'virus' }), null);
  const item = itemFromTemplate(tpl);
  assert.equal(item.type, 'login');
  assert.equal(item.username, 'admin');
});

test('protection: only a real true locks or demands; "Nur für mich" forbidden only by the exact word', () => {
  const p = cleanVaultSettings({ protect: { pinCopy: true, pinExport: true, noExport: true, private: 'forbid' } }).protect;
  assert.deepEqual(p, { pinCopy: true, pinExport: true, noExport: true, private: 'forbid' });
  assert.equal(cleanVaultSettings({ protect: { private: 'FORBID' } }).protect.private, 'allow');
  assert.equal(cleanVaultSettings({ protect: { noExport: 'true' } }).protect.noExport, false);
});

test('review 0.9.33: contact mail without ? & = %, the mailto: link carries only the address', async () => {
  const { cleanEmail, mailtoOf } = await import('../extension/core/vault-settings.js');
  for (const bad of ['a?bcc=evil@x.de@contoso.com', 'it&subject=x@contoso.com', 'it=1@contoso.com', 'it%3Fbcc@contoso.com', 'it?body=x@contoso.com']) {
    assert.equal(cleanEmail(bad), '', bad);
    assert.equal(mailtoOf(bad), '', bad);
  }
  assert.equal(mailtoOf('kontakt@example.test'), 'mailto:kontakt@example.test');
  assert.equal(mailtoOf('o.brien+it@contoso.com'), 'mailto:o.brien%2Bit@contoso.com');
  const url = new URL(mailtoOf('a.b#c/d@contoso.com'));
  assert.equal(url.search, '', 'no header fields');
  assert.equal(url.hash, '', 'no fragment');
});
