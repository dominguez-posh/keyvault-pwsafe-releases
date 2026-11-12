// Keevault-Einrichtung (#501): the window of the setup tool. All work happens in the PowerShell engine; this page only
// collects the choice, shows the checklist and the dry run, and asks for the confirmation before anything is written.
// Data from the tenant is only ever set as text (textContent), never as HTML. Texts: i18n.js (window) and the engine
// (steps, questions), both in German and English.
'use strict';

const CAN_LABELS = { armWrite: 'canArmWrite', roleAssign: 'canRoleAssign', groupCreate: 'canGroupCreate' };

const $ = (id) => document.getElementById(id);
let plan = null;
let dry = null; // last dry run: { result, planJson }
let validateTimer = 0;
let lang = 'de';
let stepLabels = {};
let questions = []; // [{ id, step, text }]
let lastRights = null;

function t(key, ...args) {
  const text = (window.KS_TEXT[lang] || window.KS_TEXT.de)[key] ?? key;
  return text.replace(/\{(\d)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));
}

function applyTexts() {
  document.documentElement.lang = lang;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  $('lang').value = lang;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

async function api(name, body = {}) {
  const r = await fetch('/api/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Keevault-Setup': '1' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || t('error', r.status));
  return data;
}

function showError(e) {
  const box = $('error');
  box.textContent = e ? String(e.message || e) : '';
  box.hidden = !e;
}

async function busy(button, fn) {
  const was = button.disabled;
  button.disabled = true;
  showError(null);
  try { await fn(); } catch (e) { showError(e); } finally { button.disabled = was; updateButtons(); }
}

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- sign-in and rights
function renderContext(ctx) {
  $('signin-form').hidden = ctx.SignedIn;
  $('account').textContent = ctx.SignedIn ? ctx.Account : t('notSignedIn');
}

function renderRights() {
  const rights = lastRights;
  const box = $('rights');
  if (!rights) { box.hidden = true; return; }
  const roles = [...rights.EntraRoles.map((r) => 'Entra: ' + r.Name), ...rights.AzureRoles.map((r) => 'Azure: ' + r.Name)];
  const p2 = rights.EntraP2 === true ? 'yes' : rights.EntraP2 === false ? 'no' : 'unknown';
  box.replaceChildren(
    el('p', { text: t('signedInAs', rights.Account) }),
    el('p', { class: 'muted small', text: roles.length ? t('activeRoles', roles.join(', ')) : t('noRoles') }),
    el('div', { class: 'rights-grid' },
      Object.entries(CAN_LABELS).flatMap(([k, label]) => [
        el('span', { class: 'chip ' + (rights.Can[k] ? 'done' : 'noRight'), text: rights.Can[k] ? t('yes') : t('no') }),
        el('span', { text: t(label) }),
      ]),
      el('span', { class: 'chip ' + (p2 === 'yes' ? 'done' : p2 === 'no' ? 'info' : 'manual'), text: t(p2) }),
      el('span', { text: t('p2') }),
    ),
    ...rights.Notes.map((n) => el('p', { class: 'muted small', text: n })),
  );
  box.hidden = false;
}

async function loadRights() {
  if (!plan) return;
  const { rights } = await api('rights', { subscriptionId: plan.target.subscriptionId, resourceGroup: plan.resourceGroup });
  lastRights = rights;
  renderRights();
}

// ---------------------------------------------------------------- plan form
function renderQuestions() {
  $('questions').replaceChildren(...questions.map((q) => el('div', { class: 'field', 'data-step': q.step },
    el('label', { for: 'q-' + q.id, text: q.text }),
    el('input', { id: 'q-' + q.id, autocomplete: 'off', maxlength: '500', value: plan.answers[q.id] || '', oninput: (e) => { plan.answers[q.id] = e.target.value; changed(); } }),
  )));
  showQuestions();
}

function showQuestions() {
  for (const node of $('questions').children) node.hidden = !plan.steps[node.dataset.step];
}

function renderPlan() {
  $('subscription').value = plan.target.subscriptionId;
  $('location').value = plan.target.location;
  $('rg').value = plan.resourceGroup;
  $('pattern').value = plan.groupPattern;
  const rows = plan.vaults.map((v, i) => el('div', { class: 'vault-row' },
    el('input', { value: v.name, placeholder: t('vaultName'), 'aria-label': t('vaultNameLabel'), autocomplete: 'off', oninput: (e) => { v.name = e.target.value.trim(); changed(); } }),
    el('input', { value: v.displayName, placeholder: t('displayName'), 'aria-label': t('displayName'), autocomplete: 'off', oninput: (e) => { v.displayName = e.target.value; changed(); } }),
    el('button', { class: 'btn small danger', type: 'button', text: t('remove'), onclick: () => { plan.vaults.splice(i, 1); renderPlan(); changed(); } }),
  ));
  $('vaults').replaceChildren(...rows);
  $('steps').replaceChildren(...Object.entries(stepLabels).map(([k, label]) => el('label', { class: 'inline' },
    el('input', { type: 'checkbox', ...(plan.steps[k] ? { checked: '' } : {}), onchange: (e) => { plan.steps[k] = e.target.checked; changed(); } }),
    label,
  )));
  renderQuestions();
  renderDevice();
}

// ---------------------------------------------------------------- device policies (part d)
const TRI = [['', 'dpUnset'], ['on', 'dpOn'], ['off', 'dpOff']];
const toTri = (v) => (v === true ? 'on' : v === false ? 'off' : '');
const fromTri = (v) => (v === 'on' ? true : v === 'off' ? false : null);

function select(id, label, options, value, onchange) {
  return el('div', { class: 'field' },
    el('label', { for: id, text: t(label) }),
    el('select', { id, onchange: (e) => { onchange(e.target.value); changed(); } },
      options.map(([v, text]) => el('option', { value: v, ...(v === value ? { selected: '' } : {}), text: t(text) }))),
  );
}

function renderDevice() {
  const d = plan.devicePolicy;
  const tri = (key, label) => select('dp-' + key, label, TRI, toTri(d[key]), (v) => { d[key] = fromTri(v); });
  const text = (key, label) => el('div', { class: 'field' },
    el('label', { for: 'dp-' + key, text: t(label) }),
    el('input', { id: 'dp-' + key, autocomplete: 'off', value: d[key] || '', oninput: (e) => { d[key] = e.target.value.trim(); changed(); } }));
  const check = (label, checked, onchange) => el('label', { class: 'inline' },
    el('input', { type: 'checkbox', ...(checked ? { checked: '' } : {}), onchange: (e) => { onchange(e.target.checked); changed(); } }), t(label));
  const browser = (b, label) => check(label, d.extensionBrowsers.includes(b), (on) => {
    d.extensionBrowsers = ['edge', 'chrome'].filter((x) => (x === b ? on : d.extensionBrowsers.includes(x)));
  });
  $('device').replaceChildren(
    select('dp-scope', 'dpScope', [['machine', 'dpMachine'], ['user', 'dpUser']], d.scope, (v) => { d.scope = v; }),
    tri('requirePin', 'dpRequirePin'),
    select('dp-updateChannel', 'dpUpdateChannel', [['', 'dpUnset'], ['stable', 'dpStable'], ['beta', 'dpBeta']], d.updateChannel, (v) => { d.updateChannel = v; }),
    select('dp-updateMode', 'dpUpdateMode', [['', 'dpUnset'], ['ask', 'dpModeAsk'], ['auto', 'dpModeAuto'], ['off', 'dpModeOff']], d.updateMode, (v) => { d.updateMode = v; }),
    tri('browserIntegration', 'dpBrowserIntegration'),
    tri('windowsProvider', 'dpWindowsProvider'),
    text('tenantId', 'dpTenant'),
    text('clientId', 'dpClient'),
    el('div', { class: 'field' }, el('span', { class: 'label', text: t('dpExtension') }), el('div', {}, browser('edge', 'Edge'), ' ', browser('chrome', 'Chrome'))),
    select('dp-source', 'dpSource', [['github', 'dpGithub'], ['store', 'dpStore']], d.extensionSource, (v) => { d.extensionSource = v; }),
    check('dpVaults', d.connectVaults, (on) => { d.connectVaults = on; }),
  );
}

async function saveDevicePolicy() {
  readForm();
  if (!(await validate())) throw new Error(t('fixFirst'));
  const r = await api('devicepolicy', { plan });
  download(r.name, Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)), r.type);
}

function readForm() {
  plan.target.subscriptionId = $('subscription').value.trim();
  plan.target.location = $('location').value.trim();
  plan.resourceGroup = $('rg').value.trim();
  plan.groupPattern = $('pattern').value.trim();
  for (const q of questions) { const input = $('q-' + q.id); if (input) plan.answers[q.id] = input.value; }
}

function changed() {
  dry = null;
  $('checklist').replaceChildren();
  showQuestions();
  updateButtons();
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validate, 300);
}

async function validate() {
  const box = $('plan-errors');
  try {
    const r = await api('validate', { plan });
    box.replaceChildren(...r.errors.map((e) => el('li', { text: e })));
    box.hidden = r.valid;
    return r.valid;
  } catch (e) {
    showError(e);
    return false;
  }
}

// ---------------------------------------------------------------- checklist, dry run and run
function renderChecklist(result) {
  $('checklist').replaceChildren(...result.Steps.map((s) => el('li', {},
    el('div', { class: 'row' },
      el('span', { class: 'chip ' + s.Status, text: s.StatusText }),
      el('span', { class: 'title', text: s.Title }),
    ),
    s.Detail ? el('div', { class: 'muted small', text: s.Detail }) : null,
    s.Status === 'manual' && s.Text ? el('div', { class: 'small', text: s.Text }) : null,
    s.Actions.length ? el('ul', {}, s.Actions.map((a) => el('li', { text: a }))) : null,
  )));
}

function writes() {
  return dry ? dry.result.Steps.filter((s) => s.Status === 'planned').reduce((n, s) => n + s.Actions.length, 0) : 0;
}

function updateButtons() {
  const fresh = dry && dry.planJson === JSON.stringify(plan);
  $('run').disabled = !fresh || writes() === 0;
  for (const id of ['report', 'report-html', 'report-docx']) $(id).disabled = !dry;
}

async function dryRun() {
  readForm();
  if (!(await validate())) throw new Error(t('fixFirst'));
  const { result } = await api('dryrun', { plan });
  dry = { result, planJson: JSON.stringify(plan) };
  renderChecklist(result);
}

async function run() {
  if (!dry || dry.planJson !== JSON.stringify(plan)) throw new Error(t('needDryRun'));
  if (!window.confirm(t('confirmRun', writes()))) return;
  const { result } = await api('run', { plan, hash: dry.result.PlanHash });
  dry = { result, planJson: JSON.stringify(plan) };
  renderChecklist(result);
}

async function saveReport(format) {
  const r = await api('report', { format });
  if (r.base64) download(r.name, Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)), r.type);
  else download(r.name, r.text, r.type + ';charset=utf-8');
}

// ---------------------------------------------------------------- part e: drift, CIS/CISA, update (read-only checks)
let drift = null;
let compliance = null;
let tool = null;
let update = null;

function chipRow(status, statusText, title, ...lines) {
  return el('li', {},
    el('div', { class: 'row' }, el('span', { class: 'chip ' + status, text: statusText }), el('span', { class: 'title', text: title })),
    ...lines.filter(Boolean).map((l) => el('div', { class: 'muted small', text: l })));
}

function renderVerify() {
  const d = $('drift-result');
  d.hidden = !drift;
  if (drift) {
    const s = drift.Summary;
    const rows = drift.Items.filter((i) => i.Status !== 'ok').map((i) => chipRow('v-' + i.Status, i.StatusText, i.Object,
      i.Expected || i.Actual ? `${t('expected')}: ${i.Expected || '–'} · ${t('actual')}: ${i.Actual || '–'}` : '', i.Hint));
    d.replaceChildren(
      el('p', { text: t('driftSummary', s.ok, s.missing, s.differs, s.extra, s.notChecked) }),
      rows.length ? el('ol', { class: 'checklist' }, rows) : el('p', { class: 'muted', text: t('driftNone') }),
      drift.FixByRun ? el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', text: t('driftFix'), onclick: (e) => busy(e.target, async () => { await dryRun(); $('sec-check').scrollIntoView(); }) })) : null,
    );
  }
  const c = $('compliance-result');
  c.hidden = !compliance;
  if (compliance) {
    const s = compliance.Summary;
    c.replaceChildren(
      el('p', { text: t('ccSummary', s.pass, s.fail, s.deviation, s.manual, s.notChecked) }),
      !compliance.CisUnverified ? null : el('p', { class: 'muted small', text: t('ccDraft', compliance.CatalogVersion) }),
      el('ol', { class: 'checklist' }, compliance.Controls.map((r) => chipRow('v-' + r.Status, r.StatusText, `${r.Title} (${r.Reference})`, r.Detail, r.Why))),
    );
  }
  for (const id of ['check-html', 'check-docx', 'check-md']) $(id).disabled = !drift && !compliance;
  $('tool-version').textContent = tool && tool.Packaged ? t('toolVersion', tool.Version) : t('toolDev');
  const status = $('update-status');
  const install = $('update-install');
  status.hidden = !update;
  install.hidden = !(update && update.Available);
  if (update) {
    status.textContent = update.Available ? t('updateFound', update.Latest) : t('updateNone', update.Latest);
    install.textContent = t('updateInstall', update.Latest);
  }
}

async function checkDrift() {
  readForm();
  if (!(await validate())) throw new Error(t('fixFirst'));
  drift = (await api('drift', { plan, device: $('drift-device').checked })).result;
  renderVerify();
}

async function checkCompliance() {
  readForm();
  if (!(await validate())) throw new Error(t('fixFirst'));
  compliance = (await api('compliance', { plan })).result;
  renderVerify();
}

async function saveCheckReport(format) {
  const r = await api('checkreport', { format });
  if (r.base64) download(r.name, Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)), r.type);
  else download(r.name, r.text, r.type + ';charset=utf-8');
}

async function installUpdate() {
  if (!update || !update.Available || !window.confirm(t('updateConfirm', update.Latest))) return;
  const { install } = await api('updateinstall');
  update = null;
  renderVerify();
  const status = $('update-status');
  status.textContent = install.Installed ? t('updateDone', install.Start) : install.Reason;
  status.hidden = false;
}

$('drift').addEventListener('click', (e) => busy(e.target, checkDrift));
$('compliance').addEventListener('click', (e) => busy(e.target, checkCompliance));
$('check-html').addEventListener('click', (e) => busy(e.target, () => saveCheckReport('html')));
$('check-docx').addEventListener('click', (e) => busy(e.target, () => saveCheckReport('docx')));
$('check-md').addEventListener('click', (e) => busy(e.target, () => saveCheckReport('md')));
$('update-check').addEventListener('click', (e) => busy(e.target, async () => { update = (await api('updatecheck')).update; renderVerify(); }));
$('update-install').addEventListener('click', (e) => busy(e.target, installUpdate));

// ---------------------------------------------------------------- language and start
function useState(state) {
  lang = state.language;
  stepLabels = state.stepLabels;
  questions = state.questions;
  applyTexts();
  renderContext(state.context);
  tool = state.tool;
  renderVerify();
}

async function setLanguage(next) {
  if (plan) readForm();
  useState(await api('language', { language: next }));
  if (plan) { renderPlan(); changed(); }
  renderRights();
}

async function start() {
  const wanted = (navigator.language || 'de').toLowerCase().startsWith('de') ? 'de' : 'en';
  const state = await api('language', { language: wanted });
  useState(state);
  plan = state.defaults;
  if (!plan.vaults.length) plan.vaults.push({ name: '', displayName: '' });
  renderPlan();
  if (state.context.SignedIn) await loadRights().catch(showError);
}

for (const id of ['subscription', 'location', 'rg', 'pattern']) $(id).addEventListener('input', () => { readForm(); changed(); });
$('lang').addEventListener('change', (e) => busy(e.target, () => setLanguage(e.target.value)));
$('add-vault').addEventListener('click', () => { plan.vaults.push({ name: '', displayName: '' }); renderPlan(); changed(); });
$('connect').addEventListener('click', (e) => busy(e.target, async () => {
  const { context } = await api('connect', { tenantId: $('tenant').value.trim(), subscriptionId: plan.target.subscriptionId });
  renderContext(context);
  if (!plan.target.subscriptionId) { plan.target.subscriptionId = context.SubscriptionId; renderPlan(); }
  await loadRights();
}));
$('dryrun').addEventListener('click', (e) => busy(e.target, dryRun));
$('run').addEventListener('click', (e) => busy(e.target, run));
$('report').addEventListener('click', (e) => busy(e.target, () => saveReport('md')));
$('report-html').addEventListener('click', (e) => busy(e.target, () => saveReport('html')));
$('report-docx').addEventListener('click', (e) => busy(e.target, () => saveReport('docx')));
$('export').addEventListener('click', (e) => busy(e.target, async () => {
  readForm();
  const { json } = await api('export', { plan, portable: $('portable').checked });
  download('keevault-einrichtung.json', json, 'application/json');
}));
$('terraform').addEventListener('click', (e) => busy(e.target, async () => {
  readForm();
  if (!(await validate())) throw new Error(t('fixFirst'));
  const { name, text } = await api('terraform', { plan });
  download(name, text, 'text/plain;charset=utf-8');
}));
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  showError(null);
  try {
    const { plan: imported } = await api('import', { json: await file.text() });
    plan = imported;
    renderPlan();
    changed();
  } catch (err) { showError(err); }
});
$('device-zip').addEventListener('click', (e) => busy(e.target, saveDevicePolicy));
$('quit').addEventListener('click', async () => {
  await api('quit').catch(() => {});
  window.close();
});

start().catch(showError);
