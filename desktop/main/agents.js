// AI agents (MCP, see ../mcp.js): approving an agent, confirmations for reading, writing and signing in, audit.

import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { t } from '../../extension/core/i18n.js';
import { demo } from './boot.js';
import { config, mcp, opened, win } from './state.js';
import { send } from './session.js';
import { showWindow } from './window.js';
import { passkeyPin } from './guards.js';
import { requireUsablePasskeyPin } from './passkey-use.js';
// #381: the agent names itself (MCP client name), so its name is shown like every other value it sends.
import { renewedAgentRule, shown } from '../mcp.js';

export const mcpScriptPath = () => path.join(app.getPath('userData'), 'mcp', 'keevault-mcp.cjs');
export const mcpTrusted = () => (Array.isArray(config.get().mcpTrusted) ? config.get().mcpTrusted : [])
  .filter((x) => x && typeof x.agent === 'string' && typeof x.vaultId === 'string' && typeof x.entryId === 'string');

/** "Never ask again": the agent reads this entry without a question until revoked in the entry's context menu. */
export function trustAgentEntry({ agent, vaultId, entryId, title }) {
  const others = mcpTrusted().filter((x) => !(x.agent === agent && x.vaultId === vaultId && x.entryId === entryId));
  config.update({ mcpTrusted: [...others, { agent, vaultId, entryId, title }] });
  send({ type: 'mcpTrusted' });
}

/** #369: is this agent allowed right now? Asked on every call, a running agent loses access with its approval. */
export function agentAdmitted(agent) {
  const s = config.get();
  if (!s.mcpEnabled || !s.approvedAgents.includes(agent)) return false;
  const until = s.agentRules?.[agent]?.until;
  return !until || Date.parse(until) > Date.now();
}

/** Each agent (MCP client name) is allowed once; off unless switched on (or forbidden by policy). */
export async function approveAgent(agent) {
  const s = config.get();
  if (!s.mcpEnabled || demo) return false;
  if (agentAdmitted(agent)) return true;
  // The approval ran out: ask again.
  // #381: what the old approval granted (read grants for a session or an hour) ends with it.
  if (s.approvedAgents.includes(agent)) {
    config.update({ approvedAgents: s.approvedAgents.filter((x) => x !== agent) });
    mcp?.revoke(agent);
  }
  const previous = s.agentRules?.[agent];
  const answer = await askInApp({
    kind: 'agent-connect',
    agent: shown(agent),
    title: t('„{agent}“ möchte sich verbinden', { agent: shown(agent) }),
    lead: t('Ein KI-Agent möchte Keevault nutzen. Erlaube das nur für Agenten, die du selbst eingerichtet hast.'),
    choices: [
      // #369: the first choice is preselected, so read-only comes first.
      { value: 'read', label: t('Nur lesen'), hint: t('Suchen und Passwörter mit deiner Freigabe lesen – keine Änderungen.') },
      { value: 'write', label: t('Lesen und Schreiben'), hint: t('Suchen, Passwörter mit deiner Freigabe lesen, Einträge mit Bestätigung anlegen und ändern.') },
    ],
    note: t('Löschen ist nie möglich. Rechte und Gültigkeit änderst du jederzeit in den Einstellungen.'),
    allow: t('Verbinden'),
    cancel: 'deny',
  });
  if (answer === 'deny') return false;
  config.update({
    approvedAgents: [...config.get().approvedAgents, agent],
    agentRules: { ...config.get().agentRules, [agent]: renewedAgentRule(previous, answer === 'write') },
  });
  return true;
}

export async function confirmAgentRead({ agent, title, vault: vaultName }) {
  return askInApp({
    kind: 'agent-read',
    agent: shown(agent),
    title: t('„{agent}“ möchte ein Passwort lesen', { agent: shown(agent) }),
    entry: title,
    vault: vaultName,
    choices: [
      { value: 'once', label: t('Nur dieses Mal'), hint: t('Beim nächsten Passwort fragt Keevault wieder.') },
      { value: 'session', label: t('Für diese Sitzung'), hint: t('Bis der Agent beendet wird, höchstens 8 Stunden.') },
      { value: 'minutes:60', label: t('Für 1 Stunde'), hint: t('Ohne Rückfrage – auch wenn der Agent zwischendurch neu startet.') },
      { value: 'minutes:240', label: t('Für 4 Stunden'), hint: t('Ohne Rückfrage – auch wenn der Agent zwischendurch neu startet.') },
      { value: 'always', label: t('Für diesen Eintrag nie mehr fragen'), hint: t('Nur dieser Agent, nur dieses Passwort – bis du es per Rechtsklick auf den Eintrag entziehst.') },
    ],
    note: t('Sperren von Keevault beendet jede zeitliche Freigabe.'),
    allow: t('Erlauben'),
    cancel: 'deny',
  });
}

/** #308: every single passkey sign-in of an agent – no "for this session", no "never ask again". */
export async function confirmAgentPasskey({ agent, title, username = '', vault: vaultName, rpId, origin }) {
  // #439: no PIN set → no passkey is used (the app asks for one); the PIN is typed in this dialog, never by the agent.
  requireUsablePasskeyPin();
  return (await askInApp({
    pin: passkeyPin.state().required,
    kind: 'agent-passkey',
    agent: shown(agent),
    title: t('„{agent}“ möchte sich mit einem Passkey anmelden', { agent: shown(agent) }),
    lead: t('Website: {origin} (Passkey für {rpId}). Keevault signiert nur diese eine Anmeldung, der Passkey selbst bleibt im Tresor.', { origin, rpId }),
    entry: title,
    // #331: which account signs in – several Microsoft logins are otherwise hard to tell apart.
    username,
    vault: vaultName,
    note: t('Nur erlauben, wenn du diese Anmeldung gerade erwartest.'),
    allow: t('Diese Anmeldung erlauben'),
    cancel: 'deny',
  })) === 'allow';
}

/** #315: a tool asks for a Microsoft sign-in – the user picks the account (or refuses). → entry key or null */
export async function chooseAgentMicrosoft({ agent, purpose, accounts }) {
  const answer = await askInApp({
    kind: 'agent-microsoft',
    agent: shown(agent),
    title: t('„{agent}“ möchte sich bei Microsoft anmelden', { agent: shown(agent) }),
    lead: purpose ? t('Zweck laut Tool: {purpose}', { purpose }) : t('Wähle das Konto, mit dem sich das Tool anmelden soll.'),
    // #333: accounts of the requested tenant come first; the others stay selectable, marked as another tenant
    // #339: all accounts (no cut at 20) – the dialog has a search and a vault filter; vault and search text per choice.
    choices: accounts.slice(0, 500).map((a) => ({
      value: a.key,
      label: a.title,
      hint: [a.username, a.vault, a.otherTenant ? t('anderer Tenant') : ''].filter(Boolean).join(' · '),
      vault: a.vault || '',
      search: [a.title, a.username, a.vault].filter(Boolean).join(' ').toLowerCase(),
    })),
    filter: true,
    note: t('Das Tool bekommt Benutzername, Passwort und den aktuellen Einmalcode dieses Kontos – nur dieses eine Mal.'),
    allow: t('Mit diesem Konto anmelden'),
    cancel: 'deny',
  });
  return accounts.some((a) => a.key === answer) ? answer : null;
}

export async function confirmAgentWrite({ agent, action, title, vault: vaultName, fields, changes }) {
  return (await askInApp({
    kind: 'agent-write',
    agent: shown(agent),
    title: action === 'create' ? t('„{agent}“ möchte einen Eintrag anlegen', { agent: shown(agent) }) : t('„{agent}“ möchte einen Eintrag ändern', { agent: shown(agent) }),
    entry: title,
    vault: vaultName,
    fields,
    changes,
    allow: action === 'create' ? t('Anlegen') : t('Ändern'),
    cancel: 'deny',
  })) === 'allow';
}

// ---- Questions to the user from background requests (AI agents): a dialog in the app's own style, window in front.
export const questions = new Map(); // id → resolve
const refusals = new Map(); // id → the answer that refuses
const pinQuestions = new Set(); // ids of questions that are answered only with the app PIN (#439)
let questionSeq = 0;

/**
 * The window's answer to a question. A question with a PIN (a passkey use) is answered with anything but a refusal only
 * with the right app PIN: otherwise it stays open and the window shows why (wrong PIN, too many attempts). The PIN is used
 * up by this one answer.
 */
export async function answerQuestionFromWindow(id, value, pin) {
  if (!questions.has(id)) return false;
  if (pinQuestions.has(id) && String(value) !== refusals.get(id)) await passkeyPin.check(typeof pin === 'string' ? pin : '');
  const resolve = questions.get(id);
  if (!resolve) return false;
  questions.delete(id);
  pinQuestions.delete(id);
  resolve(String(value));
  return true;
}

/** Locking: an open question is refused. Allowed later, it would hand out what was read before the lock (#374). */
export function cancelQuestions() {
  for (const [id, resolve] of questions) {
    questions.delete(id);
    pinQuestions.delete(id);
    send({ type: 'questionClose', id });
    resolve(refusals.get(id));
  }
}

/** The native dialog can't delay its buttons (#368): "Deny" is its default, so Enter right after it opens refuses. */
export function nativeQuestion(spec) {
  const options = spec.choices ? spec.choices.map((c) => ({ value: c.value, label: c.label })) : [{ value: 'allow', label: spec.allow }];
  return {
    options,
    box: {
      type: 'question', buttons: [...options.map((o) => o.label), t('Ablehnen')], defaultId: options.length, cancelId: options.length, noLink: true,
      message: spec.title, detail: [spec.lead, spec.entry && [spec.entry, spec.username, spec.vault].filter(Boolean).join(' · '), spec.fields?.join(', '),
        spec.changes?.map((c) => `${c.field}: ${c.from === undefined ? '' : `${c.from || t('(leer)')} → `}${c.to || t('(leer)')}${c.host ? `\n${t('Ziel: {host}', { host: c.host })}` : ''}`).join('\n'), spec.note].filter(Boolean).join('\n\n'),
    },
  };
}

/**
 * spec: { kind, agent, title, lead?, entry?, vault?, fields?, choices?: [{ value, label, hint }], note?, allow, cancel }
 * → the chosen choice (or 'allow' without choices), or `cancel`. The window comes to the front and stays on top
 * while the question is open (agents wait for it). Without a ready window the native dialog asks instead.
 */
export async function askInApp(spec) {
  showWindow();
  // The native dialog has no field for the PIN: a question that needs one is refused instead.
  if (spec.pin && (!win || win.webContents.isLoading())) return spec.cancel;
  if (!win || win.webContents.isLoading()) {
    const { options, box } = nativeQuestion(spec);
    const r = await dialog.showMessageBox(win || null, box);
    return options[r.response]?.value ?? spec.cancel;
  }
  const id = ++questionSeq;
  win.setAlwaysOnTop(true, 'floating');
  win.flashFrame(true);
  try {
    return await new Promise((resolve) => {
      questions.set(id, resolve);
      refusals.set(id, spec.cancel);
      if (spec.pin) pinQuestions.add(id);
      send({ type: 'question', id, ...spec });
      // Nobody answers within 5 minutes: treated as the cancel choice (the agent gets a refusal, not a hang).
      setTimeout(() => {
        if (questions.delete(id)) {
          pinQuestions.delete(id);
          send({ type: 'questionClose', id });
          resolve(spec.cancel);
        }
      }, 5 * 60_000);
    });
  } finally {
    refusals.delete(id);
    pinQuestions.delete(id);
    if (!questions.size && win) {
      win.setAlwaysOnTop(false);
      win.flashFrame(false);
    }
  }
}

/**
 * A request (AI agent) while Keevault is locked: the window comes to the front with its unlock screen – above all
 * other windows, taskbar flashing – and the request waits up to two minutes instead of failing at once.
 */
export async function waitForUnlock({ ms = 120_000, isOpen = () => opened } = {}) {
  if (isOpen()) return true;
  showWindow();
  win.setAlwaysOnTop(true, 'floating');
  win.flashFrame(true);
  try {
    for (const until = Date.now() + ms; !isOpen() && Date.now() < until && !win.isDestroyed();) await new Promise((r) => setTimeout(r, 250));
    return isOpen();
  } finally {
    if (!questions.size && win && !win.isDestroyed()) {
      win.setAlwaysOnTop(false);
      win.flashFrame(false);
    }
  }
}

/** Log of agent calls (no secret values) in the profile; rotates at 1 MB. */
export async function auditAgent(entry) {
  const file = path.join(app.getPath('userData'), 'mcp-audit.log');
  try {
    if ((await fs.stat(file).catch(() => null))?.size > 1_000_000) await fs.rename(file, `${file}.1`);
    await fs.appendFile(file, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // Logging must never break the call.
  }
}

export const mcpHandlers = {
  hello: async (_msg, client) => {
    client.agent = client.origin.slice(4);
    mcp.connect(client);
    return { version: app.getVersion() };
  },
  'mcp:call': ({ tool, args }, client) => mcp.call(client, tool, args),
};
