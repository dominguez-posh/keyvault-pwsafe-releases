// Device-wide setup from the app (certificate trust for the passkey provider, browser policy for the extension).
// The elevated part runs only fixed system programs (cmd.exe with reg.exe) from the Windows folder with arguments
// built here from constants – never a script or program from the installation folder, which a per-user install lets
// the user write to (#395). Reading is done without elevation; success is judged by reading the registry again.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const exec = promisify(execFile);

export const EXTENSION_ID = 'pbkjijhihclckeeefbepoedgdmajioip';
export const UPDATE_URL = 'https://github.com/dominguez-posh/keyvault-pwsafe-releases/releases/latest/download/update.xml';
export const POLICY_VALUE = `${EXTENSION_ID};${UPDATE_URL}`;
/** #455: fixed feed of the Early Access extension (release.mjs --early-access writes update-ea.xml there; test/ea-channel.test.js compares). */
export const EARLY_ACCESS_FEED = 'https://raw.githubusercontent.com/dominguez-posh/keyvault-pwsafe-releases/early-access/update-ea.xml';
/** The feed of an update channel ('beta' = Early Access); only these two exist, nothing else can be passed. */
export const feedFor = (channel) => (channel === 'beta' ? EARLY_ACCESS_FEED : UPDATE_URL);
/** The one fixed ExtensionSettings value per feed: always exactly this string, so it fits reg.exe without any escaping logic. */
export const settingsValue = (feed) => JSON.stringify({ [EXTENSION_ID]: { update_url: feed, override_update_url: true } });
const SETTINGS_VALUES = [UPDATE_URL, EARLY_ACCESS_FEED].map(settingsValue);
export const SETTINGS_NAME = 'ExtensionSettings';
/** Entries of an earlier release of ours (older update address) may be replaced; everything else with our ID is foreign. */
const OWN_SOURCE = `${EXTENSION_ID};https://github.com/dominguez-posh/`;
export const POLICY_KEYS = {
  edge: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist',
  chrome: 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist',
};
/** Set by the MSI (KV_NO_POLICY=1) or setup.ps1 -SkipExtensionPolicy: the company sets the policy itself, for good. */
export const NO_POLICY_KEY = 'HKLM\\SOFTWARE\\Keevault';
export const NO_POLICY_VALUE = 'NoExtensionPolicy';
export const POLICY_BASES = {
  edge: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge',
  chrome: 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome',
};
/** #455: the same browsers per user. Keevault never writes there, so anything in them belongs to the company. */
export const USER_POLICY_BASES = {
  edge: 'HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge',
  chrome: 'HKCU\\SOFTWARE\\Policies\\Google\\Chrome',
};
/**
 * #455: signs of cloud management outside the two bases, as [key, value]: any of them makes the browser the company's.
 * Values inside the bases (CloudManagementEnrollmentToken, EdgeManagementEnrollmentToken, …) count already, the bases
 * are read in full. Sources: Chromium updater functional spec (enrollment token in Policies\<Company>\CloudManagement
 * and in ClientState of the updater and of the legacy Google Update, dmtoken in WOW6432Node\<Company>\Enrollment and
 * <Company>\<Browser>\Enrollment) and Google's Chrome Enterprise help 9301891 (dmtoken in both Enrollment keys).
 * "unverified": not in those documents, kept because a mark can only make Keevault create less (fail-closed).
 */
const CLIENT_STATE = ['HKLM\\SOFTWARE\\WOW6432Node\\Google\\Update\\ClientState', 'HKLM\\SOFTWARE\\Google\\Update\\ClientState'];
// The updater's own app ID (unverified: the spec names it only {UpdaterAppID}) and the legacy Google Update one (from the spec).
const UPDATER_APPS = ['{44fc7fe2-65ce-487c-93f4-edee46eeaaab}', '{430FD4D0-B729-4F61-AA34-91526481799D}'];
export const CLOUD_MARKS = {
  edge: [
    // unverified: the same Chromium updater under the company name Microsoft; Microsoft documents only the policy in the base.
    ['HKLM\\SOFTWARE\\Policies\\Microsoft\\CloudManagement', 'EnrollmentToken'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Enrollment', 'dmtoken'],
    ['HKLM\\SOFTWARE\\Microsoft\\Edge\\Enrollment', 'dmtoken'],
  ],
  chrome: [
    ['HKLM\\SOFTWARE\\Policies\\Google\\CloudManagement', 'EnrollmentToken'],
    ...CLIENT_STATE.flatMap((cs) => UPDATER_APPS.map((app) => [`${cs}\\${app}`, 'CloudManagementEnrollmentToken'])),
    ['HKLM\\SOFTWARE\\WOW6432Node\\Google\\Enrollment', 'dmtoken'],
    ['HKLM\\SOFTWARE\\Google\\Chrome\\Enrollment', 'dmtoken'],
    ['HKLM\\SOFTWARE\\Policies\\Google\\Update', 'CloudManagementEnrollmentToken'], // unverified
    ['HKLM\\SOFTWARE\\Google\\Enrollment', 'dmtoken'], // unverified (64-bit view of the documented WOW6432Node key)
  ],
};
const CERT_STORE_KEY ='HKLM\\SOFTWARE\\Microsoft\\SystemCertificates\\TrustedPeople\\Certificates';
const MAX_CERT_BYTES = 3000; // keeps the command line far below the cmd.exe limit

/** "    1    REG_SZ    value" lines of `reg query` → [{ name, value }]. */
export function parseRegQuery(stdout) {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_SZ\s+(.*?)\s*$/.exec(line);
    if (m) out.push({ name: m[1], value: m[2] });
  }
  return out;
}

/** Where we stand in one Forcelist: our current entry, an older one of ours (replaceable), a foreign one, or none. */
export function classifyForcelist(entries) {
  if (!entries) return { state: 'missing', free: '1' };
  const mine = entries.find((e) => e.value.startsWith(`${EXTENSION_ID};`) || e.value === EXTENSION_ID);
  if (mine) {
    if (!LIST_NAME.test(mine.name)) return { state: 'theirs', name: mine.name };
    if (mine.value === POLICY_VALUE) return { state: 'current', name: mine.name };
    if (mine.value.startsWith(OWN_SOURCE)) return { state: 'own-old', name: mine.name };
    return { state: 'theirs', name: mine.name };
  }
  return { state: 'missing', free: freeName(entries) };
}

/** #494: Forcelist value names Keevault writes, replaces or deletes are plain numbers; any other name (e.g. "/va") is foreign. */
const LIST_NAME = /^\d+$/;

/** The first number not yet used as a value name in a Forcelist. */
export function freeName(entries) {
  let n = 1;
  while ((entries || []).some((e) => e.name === String(n))) n++;
  return String(n);
}

/** Value "ExtensionSettings" of a `reg query base /v ExtensionSettings` output → { type, value } or null. */
export function parseSettingsValue(stdout) {
  const m = /^\s+ExtensionSettings\s+(REG_\w+)\s+(.*?)\s*$/m.exec(String(stdout ?? ''));
  return m ? { type: m[1], value: m[2] } : null;
}

/** #494: an older update address of ours in ExtensionSettings: the release repo, any tag or latest, an update*.xml. */
const OWN_OLD_FEED = /^https:\/\/github\.com\/dominguez-posh\/keyvault-pwsafe-releases\/releases\/(?:latest\/download|download\/[A-Za-z0-9._-]+)\/update[A-Za-z0-9._-]*\.xml$/;
const OWN_FIELDS = ['installation_mode', 'update_url', 'override_update_url'];
// Only modes that install us: a company blocking or removing Keevault this way stays the company's (fail-closed).
const OWN_MODES = 'force_installed normal_installed'.split(' ');

/**
 * #494 (CTO decision 10.11.): an ExtensionSettings an earlier setup of ours wrote, e.g. the Early Access workaround of
 * 0.9.29 ({ "<our id>": { update_url: ".../download/v0.9.29/update-ea.xml", override_update_url: true } }). Only our ID
 * as the one key, only our known fields, update_url to our release repo. It is replaced by the fixed value.
 */
function ownOldSettings(value) {
  let json;
  try {
    json = JSON.parse(value);
  } catch {
    return false;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json) || Object.keys(json).join() !== EXTENSION_ID) return false;
  const e = json[EXTENSION_ID];
  if (!e || typeof e !== 'object' || Array.isArray(e) || !Object.keys(e).every((k) => OWN_FIELDS.includes(k))) return false;
  if (typeof e.update_url !== 'string' || !OWN_OLD_FEED.test(e.update_url)) return false;
  if ('override_update_url' in e && typeof e.override_update_url !== 'boolean') return false;
  return !('installation_mode' in e) || OWN_MODES.includes(e.installation_mode);
}

/**
 * ExtensionSettings of one browser: 'missing', 'ours' (the fixed value of one of our two feeds, feed set; or an older
 * value of ours, feed null, #494) or 'company'. Any other key, other content, another type or unreadable JSON: the whole
 * policy belongs to someone else (#455).
 */
export function classifySettings(raw) {
  if (raw == null) return { state: 'missing' };
  if (raw.type !== 'REG_SZ') return { state: 'company' };
  const index = SETTINGS_VALUES.indexOf(String(raw.value).trim());
  if (index >= 0) return { state: 'ours', feed: [UPDATE_URL, EARLY_ACCESS_FEED][index] };
  return ownOldSettings(String(raw.value).trim()) ? { state: 'ours', feed: null } : { state: 'company' };
}

/** A Forcelist value Keevault writes: one of our two feeds, or an older address of ours. */
const ownForcelistValue = (value) => [POLICY_VALUE, `${EXTENSION_ID};${EARLY_ACCESS_FEED}`].includes(value) || value.startsWith(OWN_SOURCE);

/** Forcelist as above, but both of our feeds count as ours: { state: 'ours'|'theirs'|'missing', name, value, free }. */
function forcelistOfBrowser(entries) {
  const mine = (entries || []).filter((e) => e.value.startsWith(`${EXTENSION_ID};`) || e.value === EXTENSION_ID);
  if (mine.length) return mine.every((e) => ownForcelistValue(e.value) && LIST_NAME.test(e.name)) ? { state: 'ours', name: mine[0].name, value: mine[0].value } : { state: 'theirs', name: mine[0].name };
  return { state: 'missing', free: classifyForcelist(entries).free };
}

/** `reg query <key> /s` → [{ key, values: [{ name, type, value }] }], key paths in full (HKEY_…) as reg.exe prints them. */
export function parseRegTree(stdout) {
  const keys = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) keys.push({ key: line.trim(), values: [] });
    else {
      const m = /^ {4}(.+?) {4}(REG_\w+)(?: {4}(.*))?$/.exec(line);
      if (m && keys.length) keys[keys.length - 1].values.push({ name: m[1], type: m[2], value: (m[3] ?? '').trim() });
    }
  }
  return keys;
}

const fullKey = (k) => k.replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\').replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\').toUpperCase();

/**
 * #494 (Lucas 08.11., "gezielt lockern"): the policies of the HKLM base that mean a company manages the extensions of this
 * browser. Keevault never writes them, so any of them, as a key or as a value, belongs to someone else. The legacy names
 * (Blacklist/Whitelist) still work in the browsers and count the same.
 */
export const COMPANY_EXTENSION_POLICIES = ['ExtensionSettings', 'ExtensionInstallBlocklist', 'ExtensionInstallAllowlist', 'ExtensionAllowedTypes',
  'ExtensionInstallBlacklist', 'ExtensionInstallWhitelist'];
const COMPANY_UPPER = COMPANY_EXTENSION_POLICIES.map((n) => n.toUpperCase());
/** Cloud enrollment written into the base itself (CloudManagementEnrollmentToken, EdgeManagementEnrollmentToken, …). */
const ENROLLMENT_VALUE = /EnrollmentToken$/i;

/**
 * Is there a sign of company management in this policy tree? Per user (machine false): anything at all, Keevault never
 * writes there. In the HKLM base (#494): only the extension policies above (as a subkey, or as a value – the value
 * ExtensionSettings is judged by classifySettings instead) and enrollment tokens. Foreign Forcelist entries of other
 * extensions and unrelated policies (LocalNetworkAccessAllowedForUrls, HomepageLocation, …) do not count: Keevault never
 * touches them and only adds its own Forcelist value next to them.
 */
export function foreignInTree(stdout, base, machine) {
  const root = fullKey(base);
  return parseRegTree(stdout).some(({ key, values }) => {
    const k = key.toUpperCase();
    if (!machine) return k === root ? values.length > 0 : true;
    if (k === root) return values.some((v) => ENROLLMENT_VALUE.test(v.name) || (COMPANY_UPPER.includes(v.name.toUpperCase()) && v.name.toUpperCase() !== SETTINGS_NAME.toUpperCase()));
    return COMPANY_UPPER.some((name) => k === `${root}\\${name}` || k.startsWith(`${root}\\${name}\\`));
  });
}

/**
 * Policy of one browser: 'none', 'ours' or 'company' (a foreign Forcelist entry or ExtensionSettings anywhere: all of it is theirs).
 * foreign (#455): the company manages this browser elsewhere (per user, cloud, extension block or allow lists; #494). Then nothing
 * is created: without entries of ours it is 'company', with them managed is set and only our existing entries are switched.
 */
export function browserPolicy(entries, rawSettings, foreign = false) {
  const forcelist = forcelistOfBrowser(entries);
  const settings = classifySettings(rawSettings);
  const own = forcelist.state === 'theirs' || settings.state === 'company' ? 'company'
    : forcelist.state === 'ours' || settings.state === 'ours' ? 'ours' : 'none';
  const state = own === 'none' && foreign ? 'company' : own;
  return { state, forcelist, settings, managed: !!foreign };
}

/** Ours, and Forcelist and ExtensionSettings both point to the feed of this channel. */
export const isAligned = (p, channel) => p.state === 'ours' && p.forcelist.value === `${EXTENSION_ID};${feedFor(channel)}` && p.settings.feed === feedFor(channel);

/** Registry blob of a certificate store entry: property 32 (the encoded certificate), as Windows writes it. */
export function certBlobHex(der) {
  const head = Buffer.alloc(12);
  head.writeUInt32LE(32, 0);
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(der.length, 8);
  return Buffer.concat([head, der]).toString('hex').toUpperCase();
}

/**
 * What is still to do, as fixed registry operations. state: { cert: { der, thumbprint, trusted } | null,
 * policyBlocked, policies: { edge: entries|null, chrome: entries|null } }. Nothing is returned for what is already
 * in place or belongs to someone else.
 */
export function buildOps(state) {
  const ops = [];
  const c = state.cert;
  // Only the certificate this build was packed with (fingerprint pinned at build time): a file swapped in a per-user
  // installation must never reach the machine's trust store through the elevated start (#395).
  if (c && c.pinned === true && !c.trusted && c.der && c.der.length <= MAX_CERT_BYTES) {
    ops.push({ kind: 'cert', key: `${CERT_STORE_KEY}\\${c.thumbprint}`, hex: certBlobHex(c.der) });
  }
  if (!state.policyBlocked) {
    for (const [browser, key] of Object.entries(POLICY_KEYS)) {
      // A foreign ExtensionSettings makes the whole policy of that browser the company's (#455).
      if (classifySettings(state.settings?.[browser] ?? null).state === 'company') continue;
      const r = classifyForcelist(state.policies?.[browser] ?? null);
      // The company manages this browser elsewhere (HKCU, extension lists or ExtensionSettings as a key, cloud; #455, #494): an HKLM Forcelist of ours
      // would push its list aside, so nothing is created there; an old entry of ours may still be replaced.
      if (r.state === 'missing' && !state.foreign?.[browser]) ops.push({ kind: 'policy-add', key, name: r.free, value: POLICY_VALUE });
      else if (r.state === 'own-old') ops.push({ kind: 'policy-replace', key, name: r.name, value: POLICY_VALUE });
    }
  }
  return ops;
}

/**
 * #455: channel switch and "Fix now". Only policies of ours are touched, Forcelist and ExtensionSettings both get the feed
 * of the channel; with create also where there is nothing yet. A foreign key anywhere = company: nothing is written.
 * The remembered waiver (KV_NO_POLICY) is checked first, for switching as for creating.
 */
export function buildChannelOps(state, channel, create) {
  if (state.policyBlocked) return [];
  return Object.keys(POLICY_KEYS).flatMap((browser) => browserChannelOps(
    browserPolicy(state.policies?.[browser] ?? null, state.settings?.[browser] ?? null, state.foreign?.[browser]), browser, channel, create, state.settings?.[browser] ?? null));
}

/**
 * The operations for one browser (p from browserPolicy). Managed by the company elsewhere: only our existing entries are
 * switched, nothing added (#455). rawSettings: the ExtensionSettings as read; a replacement only happens while it is still there (#494).
 */
export function browserChannelOps(p, browser, channel, create, rawSettings = null) {
  const ops = [];
  if (p.state === 'company' || (p.state === 'none' && !create)) return ops;
  const feed = feedFor(channel);
  const want = `${EXTENSION_ID};${feed}`;
  const key = POLICY_KEYS[browser];
  if (p.forcelist.state === 'missing') { if (!p.managed) ops.push({ kind: 'policy-add', key, name: p.forcelist.free, value: want }); }
  else if (p.forcelist.value !== want) ops.push({ kind: 'policy-replace', key, name: p.forcelist.name, value: want });
  if (p.settings.state === 'missing') { if (!p.managed) ops.push({ kind: 'settings-add', key: POLICY_BASES[browser], name: SETTINGS_NAME, value: settingsValue(feed) }); }
  else if (p.settings.feed !== feed) ops.push({ kind: 'settings-replace', key: POLICY_BASES[browser], name: SETTINGS_NAME, value: settingsValue(feed), old: rawSettings?.value });
  return ops;
}

/** "Fix now" would change something in this browser (p from browserPolicy). */
export const canFix = (p, browser, channel) => browserChannelOps(p, browser, channel, true).length > 0;

/** #494: "Neu installieren" is possible in this browser: neither a company policy nor management elsewhere (p from browserPolicy). */
export const canReinstall = (p) => !!p && p.state !== 'company' && !p.managed;

/**
 * #494 "Browser-Erweiterung neu installieren": our entries are removed and written anew with the feed of the channel, in
 * the browsers listed (Edge always, Chrome when installed). Only our own values: the new Forcelist value goes into a free
 * name first, then our old values are deleted (so the extension is never without its Forcelist entry, which would remove
 * it with its data); ExtensionSettings is overwritten with the one fixed value, only while it still holds the value read
 * (missing: only while still missing). A browser with a company policy or managed elsewhere gets nothing; a waiver
 * (KV_NO_POLICY) means nothing at all.
 */
export function buildReinstallOps(state, channel, browsers = Object.keys(POLICY_KEYS)) {
  if (state.policyBlocked) return [];
  const feed = feedFor(channel);
  return browsers.filter((b) => POLICY_KEYS[b]).flatMap((browser) => {
    const entries = state.policies?.[browser] ?? null;
    const raw = state.settings?.[browser] ?? null;
    if (!canReinstall(browserPolicy(entries, raw, state.foreign?.[browser]))) return [];
    const key = POLICY_KEYS[browser];
    const own = (entries || []).filter((e) => ownForcelistValue(e.value) && LIST_NAME.test(e.name));
    const add = { kind: 'policy-add', key, name: freeName(entries), value: `${EXTENSION_ID};${feed}` };
    const settings = { key: POLICY_BASES[browser], name: SETTINGS_NAME, value: settingsValue(feed) };
    return [
      add,
      ...own.map((e) => ({ kind: 'policy-delete', key, name: e.name, value: e.value, keep: { name: add.name, value: add.value } })),
      raw == null ? { kind: 'settings-add', ...settings } : { kind: 'settings-replace', ...settings, old: raw.value },
    ];
  });
}

/** After "Neu installieren": in each of these browsers exactly one Forcelist value of ours, and both point to the channel. */
export function reinstallDone(state, channel, browsers) {
  const want = `${EXTENSION_ID};${feedFor(channel)}`;
  return browsers.every((b) => {
    const p = browserPolicy(state.policies?.[b] ?? null, state.settings?.[b] ?? null, state.foreign?.[b]);
    if (!canReinstall(p)) return true; // nothing was to be written there
    const mine = (state.policies?.[b] || []).filter((e) => e.value.startsWith(`${EXTENSION_ID};`) || e.value === EXTENSION_ID);
    return mine.length === 1 && mine[0].value === want && p.settings.feed === feedFor(channel);
  });
}

const SAFE = /^[A-Za-z0-9 \\;:/._-]+$/;
/** An ExtensionSettings value read before, quoted into the findstr check: JSON without anything cmd.exe or findstr treats specially. */
const SETTINGS_SAFE = /^[A-Za-z0-9 {}":,._/-]+$/;
const safe = (s) => {
  if (!SAFE.test(s)) throw new Error('unexpected character in registry argument');
  return s;
};

/**
 * The Windows folder, only when it is exactly C:\Windows: a changed environment variable (SystemRoot=D:\Windows with a
 * foreign reg.exe) must not point the elevated start elsewhere. Anything else: null, nothing runs elevated – the IT
 * sets the device up with the Intune script instead.
 */
export function windowsFolder(env = process.env) {
  return /^C:\\Windows$/i.test(String(env.SystemRoot || '')) ? 'C:\\Windows' : null;
}

/** A program from the checked Windows folder by full path (null without one: nothing starts). */
const systemProgram = (rel) => {
  const w = windowsFolder();
  return w ? `${w}\\System32\\${rel}` : null;
};

/** The single cmd.exe command line for the elevated start: only reg.exe, each step guarded, nothing foreign overwritten. */
export function elevatedArguments(ops, winDir = windowsFolder()) {
  if (!winDir) throw new Error('Windows folder not trusted');
  const reg = `${winDir}\\System32\\reg.exe`;
  const steps = ops.map((o) => {
    const k = `"${safe(o.key)}"`;
    if (o.kind === 'settings-add' || o.kind === 'settings-replace') {
      // Only one of the two fixed JSON strings, only into the ExtensionSettings value of the two browsers; its quotes are escaped for reg.exe.
      if (!SETTINGS_VALUES.includes(o.value) || o.name !== SETTINGS_NAME || !Object.values(POLICY_BASES).includes(o.key)) throw new Error('unexpected ExtensionSettings operation');
      // #494: a replacement names the value read before, which must be ours and plain enough for the cmd.exe line.
      if (o.kind === 'settings-replace' && !(typeof o.old === 'string' && SETTINGS_SAFE.test(o.old) && classifySettings({ type: 'REG_SZ', value: o.old }).state === 'ours')) throw new Error('unexpected ExtensionSettings operation');
      const add = `"${reg}" add ${k} /v ${SETTINGS_NAME} /t REG_SZ /d "${o.value.replace(/"/g, '\\"')}" /f`;
      if (o.kind === 'settings-add') return `"${reg}" query ${k} /v ${SETTINGS_NAME} >nul 2>&1 || ${add}`;
      // Only while the whole line still holds the value read before (findstr /X): a policy changed in the meantime stays.
      return `"${reg}" query ${k} /v ${SETTINGS_NAME} 2>nul | "${winDir}\\System32\\findstr.exe" /L /X /C:"    ${SETTINGS_NAME}    REG_SZ    ${o.old.replace(/"/g, '\\"')}" >nul && ${add}`;
    }
    // #494: Forcelist value names only as plain numbers; any other name is foreign and never touched.
    if (['policy-add', 'policy-replace', 'policy-delete'].includes(o.kind) && (!LIST_NAME.test(String(o.name)) || (o.keep && !LIST_NAME.test(String(o.keep.name))))) throw new Error('unexpected Forcelist value name');
    if (o.kind === 'policy-delete') {
      // #494: only a Forcelist value of ours, and only while it still holds the value read before (findstr from the same
      // folder checks it): a company list rewritten in the meantime keeps its entry under that name.
      // keep: the new value of ours must be in place first, else the extension would lose its Forcelist entry (and its data).
      const wants = [UPDATE_URL, EARLY_ACCESS_FEED].map((f) => `${EXTENSION_ID};${f}`);
      if (!Object.values(POLICY_KEYS).includes(o.key) || !ownForcelistValue(o.value) || !wants.includes(o.keep?.value) || o.keep.name === o.name) throw new Error('unexpected Forcelist deletion');
      const holds = (name, value) => `"${reg}" query ${k} /v ${safe(name)} 2>nul | "${winDir}\\System32\\findstr.exe" /L /C:"REG_SZ    ${safe(value)}" >nul`;
      return `${holds(o.keep.name, o.keep.value)} && ${holds(o.name, o.value)} && "${reg}" delete ${k} /v ${safe(o.name)} /f`;
    }
    if (o.kind === 'cert') return `"${reg}" query ${k} /v Blob >nul 2>&1 || "${reg}" add ${k} /v Blob /t REG_BINARY /d ${safe(o.hex)} /f`;
    const add = `"${reg}" add ${k} /v ${safe(o.name)} /t REG_SZ /d "${safe(o.value)}" /f`;
    // A new entry only into a free name (a foreign value that appeared meanwhile stays); replacing our own old one is explicit.
    return o.kind === 'policy-add' ? `"${reg}" query ${k} /v ${safe(o.name)} >nul 2>&1 || ${add}` : add;
  });
  return `/d /s /c "${steps.map((s) => `(${s})`).join(' & ')}"`;
}

const POWERSHELL = 'WindowsPowerShell\\v1.0\\powershell.exe';
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** reg.exe reading: a large company policy tree fits, a hanging read ends (#455). Any failure is null, see keyAbsent(). */
export const REG_QUERY_OPTIONS = { windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024 * 1024 };

/** Real reading and elevation; tests replace them (run: the reg.exe start behind regQuery). */
export const system = {
  run: exec,
  async regQuery(args) {
    try {
      return (await this.run(systemProgram('reg.exe'), ['query', ...args], REG_QUERY_OPTIONS)).stdout;
    } catch {
      return null;
    }
  },
  async certTrusted(thumbprint) {
    try {
      const { stdout } = await exec(systemProgram(POWERSHELL), ['-NoProfile', '-NonInteractive', '-Command',
        `[bool](Get-ChildItem Cert:\\LocalMachine\\TrustedPeople, Cert:\\LocalMachine\\Root | Where-Object Thumbprint -eq '${thumbprint}')`], { windowsHide: true });
      return /true/i.test(stdout);
    } catch {
      return false;
    }
  },
  /** UAC prompt for cmd.exe; resolves true when it ran, false when the prompt was declined or could not start. */
  async elevate(file, args) {
    try {
      await exec(systemProgram(POWERSHELL), ['-NoProfile', '-NonInteractive', '-Command',
        `Start-Process -FilePath ${psQuote(file)} -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction Stop -ArgumentList ${psQuote(args)}`], { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  },
};

export const bundledCertificate = () => path.join(process.resourcesPath || '', 'provider', 'KvPwSafe-Test.cer');

/** SHA-256 of the provider certificate, written into the app at build time (scripts/before-pack.cjs); '' when missing. */
export function pinnedFingerprint() {
  try {
    return String(JSON.parse(fs.readFileSync(new URL('./cert-pin.json', import.meta.url), 'utf8')).sha256 || '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * #455: reg.exe fails alike for a missing key, a denied read, a timeout and an oversized answer (exit code 1 or killed,
 * the message is localized). A key counts as absent only when its parent can be read and does not list it; an unreadable
 * parent is checked the same way one level up. Everything else is "may exist": the caller treats it as the company's.
 */
export async function keyAbsent(sys, key) {
  const i = key.lastIndexOf('\\');
  if (i < 0) return false;
  const parent = key.slice(0, i);
  const out = await sys.regQuery([parent]);
  if (out == null) return keyAbsent(sys, parent);
  return !parseRegTree(out).some((k) => k.key.toUpperCase() === fullKey(key));
}

/** The policy tree under base holds something foreign, or could not be read although the key may exist (fail-closed). */
async function foreignTree(sys, base, machine) {
  const out = await sys.regQuery([base, '/s']);
  return out == null ? !(await keyAbsent(sys, base)) : foreignInTree(out, base, machine);
}

/** A cloud mark is set, or could not be read although it may exist (fail-closed). */
async function cloudMark(sys, key, value) {
  if ((await sys.regQuery([key, '/v', value])) != null) return true;
  const out = await sys.regQuery([key]);
  if (out == null) return !(await keyAbsent(sys, key));
  const own = parseRegTree(out).find((k) => k.key.toUpperCase() === fullKey(key));
  return !own || own.values.some((v) => v.name.toLowerCase() === value.toLowerCase());
}

/** Policies as read from the registry: Forcelist entries and the ExtensionSettings value per browser, and the remembered waiver. */
export async function readPolicyState(sys = system) {
  const flag = await sys.regQuery([NO_POLICY_KEY, '/v', NO_POLICY_VALUE]);
  const policies = {};
  const settings = {};
  const foreign = {};
  for (const [browser, key] of Object.entries(POLICY_KEYS)) {
    const out = await sys.regQuery([key]);
    policies[browser] = out == null ? null : parseRegQuery(out);
    settings[browser] = parseSettingsValue(await sys.regQuery([POLICY_BASES[browser], '/v', SETTINGS_NAME]));
    // #455: company policies per user, beside ours in HKLM, or cloud management: then Keevault creates nothing.
    // A read that failed for any reason but a missing key counts as the company's (fail-closed).
    foreign[browser] = (await foreignTree(sys, POLICY_BASES[browser], true)) || (await foreignTree(sys, USER_POLICY_BASES[browser], false));
    for (const [markKey, value] of CLOUD_MARKS[browser]) {
      if (!foreign[browser] && (await cloudMark(sys, markKey, value))) foreign[browser] = true;
    }
  }
  return { policyBlocked: flag != null && /0x0*[1-9a-f]/i.test(flag), policies, settings, foreign };
}

export async function readState(sys = system, certFile = bundledCertificate(), pin = pinnedFingerprint()) {
  let cert = null;
  if (fs.existsSync(certFile)) {
    const x = new crypto.X509Certificate(fs.readFileSync(certFile));
    const thumbprint = x.fingerprint.replace(/:/g, '').toUpperCase();
    const pinned = /^[0-9a-f]{64}$/.test(pin) && crypto.createHash('sha256').update(x.raw).digest('hex') === pin;
    cert = { der: x.raw, thumbprint, pinned, trusted: await sys.certTrusted(thumbprint) };
  }
  return { cert, ...(await readPolicyState(sys)) };
}

/** The company sets the policy of this browser: managed elsewhere, foreign ExtensionSettings or a foreign entry with our ID. */
export const companyManaged = (state, browser) => !!state.foreign?.[browser]
  || browserPolicy(state.policies?.[browser] ?? null, state.settings?.[browser] ?? null).state === 'company';

export async function machineSetupStatus(sys = system, certFile = bundledCertificate(), pin = pinnedFingerprint()) {
  if (process.platform !== 'win32' && sys === system) return { supported: false };
  const state = await readState(sys, certFile, pin);
  const ok = (browser) => ['current', 'theirs'].includes(classifyForcelist(state.policies[browser]).state);
  return {
    supported: true,
    certTrusted: state.cert ? state.cert.trusted : true,
    edgePolicy: ok('edge'),
    chromePolicy: ok('chrome'),
    // #455: the company sets the browser policies itself; Keevault creates nothing there (the setup says so).
    edgeCompany: companyManaged(state, 'edge'),
    chromeCompany: companyManaged(state, 'chrome'),
    policyBlocked: state.policyBlocked,
    canRunSetup: buildOps(state).length > 0,
  };
}

/**
 * Sets up what is missing with one UAC prompt. Resolves { ok, changed, declined, remaining }: ok only when reading the
 * registry again shows nothing left to do, whatever the exit code of the elevated part said.
 */
export async function runMachineSetup(sys = system, certFile = bundledCertificate(), winDir = windowsFolder(), pin = pinnedFingerprint()) {
  const before = await readState(sys, certFile, pin);
  const ops = buildOps(before);
  // #455: browsers whose policy the company sets; nothing was created there, the caller says so.
  const company = before.policyBlocked ? [] : Object.keys(POLICY_KEYS).filter((b) => companyManaged(before, b));
  if (!ops.length) return { ok: true, changed: false, declined: false, remaining: [], company };
  // No trusted Windows folder: nothing runs elevated, the caller points to the Intune script.
  if (!winDir) return { ok: false, changed: false, declined: false, remaining: ops.map((o) => o.kind), company };
  const started = await sys.elevate(`${winDir}\\System32\\cmd.exe`, elevatedArguments(ops, winDir));
  const remaining = buildOps(await readState(sys, certFile, pin)).map((o) => o.kind);
  return { ok: remaining.length === 0, changed: remaining.length < ops.length, declined: !started && remaining.length === ops.length, remaining, company };
}

/** The policies of both browsers as the hint and the channel dialog need them: { edge, chrome } of browserPolicy(); a waiver counts as company. */
export async function readPolicies(sys = system) {
  const state = await readPolicyState(sys);
  const waived = { state: 'company', forcelist: { state: 'missing' }, settings: { state: 'missing' } };
  return Object.fromEntries(Object.keys(POLICY_KEYS).map((b) => [b, state.policyBlocked ? waived : browserPolicy(state.policies[b], state.settings[b], state.foreign?.[b])]));
}

const browserOfKey = (key) => Object.keys(POLICY_KEYS).find((b) => key === POLICY_KEYS[b] || key === POLICY_BASES[b]);

/**
 * #494: a guarded step found another value than the one read before, so it wrote nothing: after the elevated step a
 * value it touches holds neither what was read nor what was to be written (a policy changed in the meantime).
 */
export function changedMeanwhile(ops, after) {
  return ops.some((o) => {
    const b = browserOfKey(o.key);
    if (o.kind === 'settings-add' || o.kind === 'settings-replace') {
      const raw = after.settings?.[b] ?? null;
      const now = raw == null ? null : raw.type === 'REG_SZ' ? raw.value : undefined;
      return ![o.kind === 'settings-add' ? null : o.old, o.value].includes(now);
    }
    if (o.kind === 'policy-add' || o.kind === 'policy-delete') return ![null, o.value].includes((after.policies?.[b] || []).find((e) => e.name === o.name)?.value ?? null);
    return false;
  });
}

/**
 * Points the extension policies to the feed of a channel with one UAC prompt. Resolves { result, company }, result one of:
 * company (nothing of ours to change, nothing written), none (no policy of ours and not asked to create one), aligned,
 * unavailable (no trusted Windows folder), declined, failed, meanwhile (#494), changed. changed only when reading the registry again shows it.
 */
export async function runChannelSetup(sys = system, winDir = windowsFolder(), { channel = 'stable', create = false } = {}) {
  const state = await readPolicyState(sys);
  const states = Object.keys(POLICY_KEYS).map((b) => browserPolicy(state.policies[b], state.settings[b], state.foreign?.[b]));
  const company = state.policyBlocked || states.some((p) => p.state === 'company' || p.managed);
  const ops = buildChannelOps(state, channel, create);
  if (!ops.length) {
    if (state.policyBlocked || states.every((p) => p.state === 'company')) return { result: 'company', company: true };
    return { result: !create && states.every((p) => p.state !== 'ours') ? 'none' : 'aligned', company };
  }
  if (!winDir) return { result: 'unavailable', company };
  const started = await sys.elevate(`${winDir}\\System32\\cmd.exe`, elevatedArguments(ops, winDir));
  const afterState = await readPolicyState(sys);
  if (started && changedMeanwhile(ops, afterState)) return { result: 'meanwhile', company };
  const after = buildChannelOps(afterState, channel, create);
  if (!after.length) return { result: 'changed', company };
  return { result: !started && after.length === ops.length ? 'declined' : 'failed', company };
}

/**
 * #494 "Browser-Erweiterung neu installieren" with one UAC prompt: our entries in these browsers removed and written anew
 * with the feed of the channel. Resolves { result, browsers, company }, result one of: company (nothing of ours may be
 * written, no prompt), unavailable (no trusted Windows folder), declined, failed, meanwhile, changed. browsers: where it was written.
 * changed only when reading the registry again shows exactly our one value per browser with the channel's feed.
 */
export async function runReinstallSetup(sys = system, winDir = windowsFolder(), { channel = 'stable', browsers = Object.keys(POLICY_KEYS) } = {}) {
  const state = await readPolicyState(sys);
  const ops = buildReinstallOps(state, channel, browsers);
  const company = state.policyBlocked || browsers.some((b) => !canReinstall(browserPolicy(state.policies[b], state.settings[b], state.foreign?.[b])));
  const written = [...new Set(ops.map((o) => browserOfKey(o.key)))];
  if (!ops.length) return { result: 'company', browsers: [], company: true };
  if (!winDir) return { result: 'unavailable', browsers: written, company };
  const started = await sys.elevate(`${winDir}\\System32\\cmd.exe`, elevatedArguments(ops, winDir));
  const after = await readPolicyState(sys);
  if (started && changedMeanwhile(ops, after)) return { result: 'meanwhile', browsers: written, company };
  if (reinstallDone(after, channel, written)) return { result: started ? 'changed' : 'declined', browsers: written, company };
  return { result: started ? 'failed' : 'declined', browsers: written, company };
}
