// AI agents (MCP, see ../mcp.js): approving an agent, confirmations for reading, writing and signing in, audit.

import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { t } from '../../extension/core/i18n.js';
import { demo } from './boot.js';
import { config, mcp, opened, win } from './state.js';
import { send } from './session.js';
import { showWindow } from './window.js';

export const mcpScriptPath = () => path.join(app.getPath('userData'), 'mcp', 'keevault-mcp.cjs');
export const mcpTrusted = () => (Array.isArray(config.get().mcpTrusted) ? config.get().mcpTrusted : [])
  .filter((x) => x && typeof x.agent === 'string' && typeof x.vaultId === 'string' && typeof x.entryId === 'string');

/** "Never ask again": the agent reads this entry without a question until revoked in the entry's context menu. */
export function trustAgentEntry({ agent, vaultId, entryId, title }) {
  const others = mcpTrusted().filter((x) => !(x.agent === agent && x.vaultId === vaultId && x.entryId === entryId));
  config.update({ mcpTrusted: [...others, { agent, vaultId, entryId, title }] });
  send({ type: 'mcpTrusted' });
}

/** Each agent (MCP client name) is allowed once; off unless switched on (or forbidden by policy). */
export async function approveAgent(agent) {
  const s = config.get();
  if (!s.mcpEnabled || demo) return false;
  if (s.approvedAgents.includes(agent)) {
    const until = s.agentRules?.[agent]?.until;
    if (!until || Date.parse(until) > Date.now()) return true;
    // The approval ran out: ask again.
    config.update({ approvedAgents: s.approvedAgents.filter((x) => x !== agent) });
  }
  const answer = await askInApp({
    kind: 'agent-connect',
    agent,
    title: t('„{agent}“ möchte sich verbinden', { agent }),
    lead: t('Ein KI-Agent möchte Keevault nutzen. Erlaube das nur für Agenten, die du selbst eingerichtet hast.'),
    choices: [
      { value: 'write', label: t('Lesen und Schreiben'), hint: t('Suchen, Passwörter mit deiner Freigabe lesen, Einträge mit Bestätigung anlegen und ändern.') },
      { value: 'read', label: t('Nur lesen'), hint: t('Suchen und Passwörter mit deiner Freigabe lesen – keine Änderungen.') },
    ],
    note: t('Löschen ist nie möglich. Rechte und Gültigkeit änderst du jederzeit in den Einstellungen.'),
    allow: t('Verbinden'),
    cancel: 'deny',
  });
  if (answer === 'deny') return false;
  config.update({
    approvedAgents: [...config.get().approvedAgents, agent],
    agentRules: { ...config.get().agentRules, [agent]: { write: answer === 'write', until: null } },
  });
  return true;
}

export async function confirmAgentRead({ agent, title, vault: vaultName }) {
  return askInApp({
    kind: 'agent-read',
    agent,
    title: t('„{agent}“ möchte ein Passwort lesen', { agent }),
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
  return (await askInApp({
    kind: 'agent-passkey',
    agent,
    title: t('„{agent}“ möchte sich mit einem Passkey anmelden', { agent }),
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
    agent,
    title: t('„{agent}“ möchte sich bei Microsoft anmelden', { agent }),
    lead: purpose ? t('Zweck laut Tool: {purpose}', { purpose }) : t('Wähle das Konto, mit dem sich das Tool anmelden soll.'),
    // #333: accounts of the requested tenant come first; the others stay selectable, marked as another tenant
    choices: accounts.slice(0, 20).map((a) => ({ value: a.key, label: a.title, hint: [a.username, a.vault, a.otherTenant ? t('anderer Tenant') : ''].filter(Boolean).join(' · ') })),
    note: t('Das Tool bekommt Benutzername, Passwort und den aktuellen Einmalcode dieses Kontos – nur dieses eine Mal.'),
    allow: t('Mit diesem Konto anmelden'),
    cancel: 'deny',
  });
  return accounts.some((a) => a.key === answer) ? answer : null;
}

export async function confirmAgentWrite({ agent, action, title, vault: vaultName, fields }) {
  return (await askInApp({
    kind: 'agent-write',
    agent,
    title: action === 'create' ? t('„{agent}“ möchte einen Eintrag anlegen', { agent }) : t('„{agent}“ möchte einen Eintrag ändern', { agent }),
    entry: title,
    vault: vaultName,
    fields,
    allow: action === 'create' ? t('Anlegen') : t('Ändern'),
    cancel: 'deny',
  })) === 'allow';
}

// ---- Questions to the user from background requests (AI agents): a dialog in the app's own style, window in front.
export const questions = new Map(); // id → resolve
let questionSeq = 0;

/**
 * spec: { kind, agent, title, lead?, entry?, vault?, fields?, choices?: [{ value, label, hint }], note?, allow, cancel }
 * → the chosen choice (or 'allow' without choices), or `cancel`. The window comes to the front and stays on top
 * while the question is open (agents wait for it). Without a ready window the native dialog asks instead.
 */
export async function askInApp(spec) {
  showWindow();
  if (!win || win.webContents.isLoading()) {
    const options = spec.choices ? spec.choices.map((c) => ({ value: c.value, label: c.label })) : [{ value: 'allow', label: spec.allow }];
    const r = await dialog.showMessageBox(win || null, {
      type: 'question', buttons: [...options.map((o) => o.label), t('Ablehnen')], cancelId: options.length, noLink: true,
      message: spec.title, detail: [spec.lead, spec.entry && [spec.entry, spec.username, spec.vault].filter(Boolean).join(' · '), spec.fields?.join(', '), spec.note].filter(Boolean).join('\n\n'),
    });
    return options[r.response]?.value ?? spec.cancel;
  }
  const id = ++questionSeq;
  win.setAlwaysOnTop(true, 'floating');
  win.flashFrame(true);
  try {
    return await new Promise((resolve) => {
      questions.set(id, resolve);
      send({ type: 'question', id, ...spec });
      // Nobody answers within 5 minutes: treated as the cancel choice (the agent gets a refusal, not a hang).
      setTimeout(() => {
        if (questions.delete(id)) {
          send({ type: 'questionClose', id });
          resolve(spec.cancel);
        }
      }, 5 * 60_000);
    });
  } finally {
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
