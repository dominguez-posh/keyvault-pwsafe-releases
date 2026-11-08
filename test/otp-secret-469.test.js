// #469: a set TOTP secret can't be displayed any more – the editor shows "gesetzt" with "Erneuern"/"Entfernen", keeps
// the stored secret out of the page, and saving without "Erneuern" keeps it. MCP get_entry hands out no secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Minimal DOM: enough for dom.js h()/icon() and the editor; dump() serialises everything an element carries.
class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tagName: tag, children: [], attrs: {}, dataset: {}, style: {}, listeners: {}, className: '', value: '', innerHTML: '', disabled: false });
  }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'type') this.type = v; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this.children = c; }
  focus() {}
  fire(type) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {} }); }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (tag) => new FakeEl(tag), getElementById: () => null, body: new FakeEl('body') };

const { totpEditor, totpEditModel, resolveTotp } = await import('../extension/core/ui-totp.js');
const { McpService } = await import('../desktop/mcp.js');

const SECRET = 'JBSWY3DPEHPK3PXP';
const STORED = `otpauth://totp/Contoso:alex?secret=${SECRET}&issuer=Contoso`;
const NEW = 'GEZDGNBVGY3TQOJQ';

const dump = (n) => (n instanceof FakeEl
  ? JSON.stringify({ ...n, listeners: undefined, children: n.children.map(dump) })
  : String(n));
const find = (n, cls) => {
  if (!(n instanceof FakeEl)) return null;
  if (n.className.split(' ').includes(cls)) return n;
  for (const c of n.children) {
    const hit = find(c, cls);
    if (hit) return hit;
  }
  return null;
};
const findTag = (n, tag) => (n instanceof FakeEl ? (n.tagName === tag ? n : n.children.map((c) => findTag(c, tag)).find(Boolean) || null) : null);

test('#469 UI model: only whether a secret is set, never the secret', () => {
  assert.deepEqual(totpEditModel(STORED), { set: true });
  assert.deepEqual(totpEditModel(''), { set: false });
  assert.ok(!JSON.stringify(totpEditModel(STORED)).includes(SECRET));
});

test('#469 saving without "Erneuern" keeps the stored secret; an empty field never deletes it', () => {
  assert.equal(resolveTotp(STORED), STORED);
  assert.equal(resolveTotp(STORED, { mode: 'keep' }), STORED);
  assert.equal(resolveTotp(STORED, { mode: 'replace', input: '   ' }), STORED);
  assert.equal(resolveTotp(STORED, { mode: 'replace', input: ` ${NEW} ` }), NEW);
  assert.equal(resolveTotp(STORED, { mode: 'remove' }), '');
  assert.equal(resolveTotp('', { mode: 'replace', input: NEW }), NEW);
});

test('#469 editor with a stored secret: "gesetzt", the secret nowhere in the elements, renew and remove work', () => {
  const ed = totpEditor(STORED, { name: 'totp' });
  assert.equal(ed.el.dataset.totpState, 'keep');
  assert.ok(!dump(ed.el).includes(SECRET), 'the stored secret is not in the DOM (value, attribute, data, hidden field)');
  assert.ok(find(ed.el, 'totp-set') && find(ed.el, 'totp-renew') && find(ed.el, 'totp-remove'));
  assert.equal(findTag(ed.el, 'input'), null, 'no input at all while the secret is kept');
  assert.equal(ed.value(), STORED, 'saving without "Erneuern" keeps it');

  find(ed.el, 'totp-renew').fire('click');
  assert.equal(ed.el.dataset.totpState, 'replace');
  const input = findTag(ed.el, 'input');
  assert.equal(input.value, '', 'the new field starts empty, the old value is never put into it');
  assert.ok(!dump(ed.el).includes(SECRET));
  assert.equal(ed.value(), STORED, 'renew opened but left empty: the stored secret stays');
  input.value = NEW;
  assert.equal(ed.check(), '');
  assert.equal(ed.value(), NEW);
  input.value = 'not base32 !';
  assert.notEqual(ed.check(), '', 'an invalid new secret is refused');

  find(ed.el, 'totp-cancel').fire('click');
  assert.equal(ed.value(), STORED);
  find(ed.el, 'totp-remove').fire('click');
  assert.equal(ed.el.dataset.totpState, 'remove');
  assert.equal(ed.value(), '');
  find(ed.el, 'totp-undo').fire('click');
  assert.equal(ed.value(), STORED);
  assert.ok(!dump(ed.el).includes(SECRET));
});

test('#469 editor without a secret: a plain input for creating one', () => {
  const ed = totpEditor('', { name: 'totp' });
  assert.equal(ed.el.dataset.totpState, 'replace');
  assert.equal(find(ed.el, 'totp-cancel'), null);
  findTag(ed.el, 'input').value = STORED;
  assert.equal(ed.value(), STORED);
});

test('#469 the item editor uses the TOTP editor for the entry and for one-time code fields', () => {
  const src = readFileSync(new URL('../extension/core/ui-item.js', import.meta.url), 'utf8');
  assert.match(src, /totpEditor\(it\.totp/);
  assert.match(src, /f\.type === 'totp'\) \{\s*const ed = totpEditor\(f\.value/);
  assert.doesNotMatch(src, /value: it\.totp/);
});

test('#469 MCP get_entry: no TOTP secret, neither the entry\'s nor a field\'s – get_totp gives the code', async () => {
  const item = { id: 'e1', version: 'v1', type: 'login', title: 'Contoso', username: 'alex', password: 'Pw-1', urls: [], totp: STORED, notes: '', folder: '',
    fields: [{ name: 'Backup-Code', type: 'totp', value: `otpauth://totp/x?secret=${NEW}`, hidden: false }, { name: 'PIN', type: 'number', value: '1234' }], passkeys: [], card: {}, cert: {} };
  const vault = { containers: async () => [{ id: 'kv', name: 'Team', kind: 'keyvault', access: { write: true } }], getItem: async () => structuredClone(item), summaries: async () => [] };
  const mcp = new McpService({ admitted: () => true, policy: () => ({ write: true }), vault: () => vault, confirmRead: async () => 'session', confirmWrite: async () => true, audit: () => {} });
  const client = { agent: 'claude-ai' };
  mcp.connect(client);
  const e = await mcp.call(client, 'get_entry', { vaultId: 'kv', entryId: 'e1' });
  const json = JSON.stringify(e);
  assert.ok(!json.includes(SECRET) && !json.includes(NEW) && !json.includes('otpauth'), 'no TOTP secret in get_entry');
  assert.equal(e.hasTotp, true);
  assert.deepEqual(e.fields[0], { name: 'Backup-Code', type: 'totp', hasTotp: true });
  assert.equal(e.fields[1].value, '1234', 'other fields as before');
  const code = await mcp.call(client, 'get_totp', { vaultId: 'kv', entryId: 'e1' });
  assert.match(code.code, /^\d{6}$/);
  assert.ok(!JSON.stringify(code).includes(SECRET));
});
