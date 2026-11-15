// #537 stage 5 (E5): the copy of the settings in OneDrive, encrypted. AES-256-GCM with a key derived from the container
// key of the personal vault (HKDF, bound to the vault's id and key generation); the head – device, time, vault, key
// generation – stays readable (the offer on a new device names device and date) and is the AAD, so nothing in it can be
// changed unnoticed. Inside: the same allowlist as the plain file (desktop/settings-file.js, pickSettings) and the same
// strict reading; device-bound values (unlock keys, Hello key, PIN, counters) never go in. No Electron here.

import crypto from 'node:crypto';
import { pickSettings, SETTINGS_MARKER, SETTINGS_MAX_BYTES } from './settings-file.js';
import { openWith, sealWith } from './unlock-keys.js';

export const SEALED_VERSION = 2;
const HKDF_INFO = 'keevault/settings-copy/v1';
const HEAD_KEYS = ['device', 'exportedAt', 'vault', 'kv'];
const TOP_KEYS = ['marker', 'version', 'head', 'ct'];
/** Never in the copy, whatever the allowlist says (Konrad E5): bound to this device. A unit test checks the allowlist. */
export const DEVICE_ONLY = ['unlockKeys', 'appPin', 'pinGuard', 'personalDeviceKeys', 'helloKey', 'offlineMirror', 'refreshToken', 'recoveryKey', 'memberKeySeen', 'memberKeyDevice',
  'appSettingsSeen', 'confirmEachVaults', 'confirmEachPersonalOnly', 'mpResetsSeen', 'helloOffered']; // Konrad (fix/537-smoke): device memories

const VAULT_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const plainText = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/** Why a copy is not read; code: plain | format | vault | older | newer | tampered. */
export class SealedSettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SealedSettingsError';
    this.code = code;
  }
}
const refuse = (code, message) => { throw new SealedSettingsError(code, message); };

/** The key of the copy: HKDF-SHA256 over the personal vault's container key, bound to vault id and key generation. */
export function settingsKey(ckRaw, vaultId, kv) {
  if (!ckRaw || ckRaw.length < 16) throw new Error('no container key');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ckRaw), Buffer.from(`keevault|settings-copy|${vaultId}|${kv}`), HKDF_INFO, 32));
}

/** The encrypted copy (pretty JSON). ck: { raw }, vaultId: the personal vault, kv: its key generation. */
export function sealSettingsFile(settings, { ckRaw, vaultId, kv, device = '', now = new Date() }) {
  if (!VAULT_ID.test(String(vaultId || '')) || !Number.isInteger(kv) || kv < 1) throw new Error('no personal vault');
  const head = JSON.stringify({ device: plainText(device, 100) ? device : '', exportedAt: now.toISOString(), vault: vaultId, kv });
  const body = Buffer.from(JSON.stringify({ settings: pickSettings(settings) }));
  const ct = sealWith(settingsKey(ckRaw, vaultId, kv), body, `${SETTINGS_MARKER}|${SEALED_VERSION}|${head}`);
  return `${JSON.stringify({ marker: SETTINGS_MARKER, version: SEALED_VERSION, head, ct }, null, 2)}\n`;
}

/**
 * The readable part of a copy, without the key: { device, exportedAt, vault, kv, head, ct }. Throws plain for the old
 * plain copy (version 1 – not read from OneDrive any more), format for anything else that is not this format.
 */
export function peekSealedFile(raw) {
  const str = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : null;
  if (str === null || Buffer.byteLength(str, 'utf8') > SETTINGS_MAX_BYTES) refuse('format', 'not a settings copy (size)');
  let data;
  try {
    data = JSON.parse(str.replace(/^﻿/, ''));
  } catch {
    refuse('format', 'not a settings copy (JSON)');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.marker !== SETTINGS_MARKER) refuse('format', 'not a settings copy (marker)');
  if (data.version === 1) refuse('plain', 'plain settings copy');
  if (data.version !== SEALED_VERSION) refuse('format', 'settings copy of another version');
  if (Object.keys(data).some((k) => !TOP_KEYS.includes(k)) || typeof data.head !== 'string' || typeof data.ct !== 'string' || data.head.length > 2000) refuse('format', 'settings copy with unknown fields');
  let head;
  try {
    head = JSON.parse(data.head);
  } catch {
    refuse('format', 'settings copy with a broken head');
  }
  if (!head || typeof head !== 'object' || Array.isArray(head) || Object.keys(head).some((k) => !HEAD_KEYS.includes(k))) refuse('format', 'settings copy with unknown head fields');
  if (!plainText(head.device, 100) || typeof head.exportedAt !== 'string' || Number.isNaN(Date.parse(head.exportedAt))) refuse('format', 'settings copy with a broken head');
  if (!VAULT_ID.test(String(head.vault || '')) || !Number.isInteger(head.kv) || head.kv < 1) refuse('format', 'settings copy without its vault');
  return { device: head.device, exportedAt: new Date(head.exportedAt).toISOString(), vault: head.vault, kv: head.kv, head: data.head, ct: data.ct };
}

/**
 * Opens a copy with the personal vault's key: { settings, device, exportedAt, dropped } as parseSettingsFile gives –
 * read just as strictly (allowlist, types, vault addresses). Refuses another vault, another key generation and every
 * change (GCM tag over head and content).
 */
export function openSealedFile(raw, { ckRaw, vaultId, kv }) {
  const p = peekSealedFile(raw);
  if (p.vault !== vaultId) refuse('vault', 'settings copy of another personal vault');
  if (p.kv < kv) refuse('older', 'settings copy under an older key');
  if (p.kv > kv) refuse('newer', 'settings copy under a newer key');
  const plain = openWith(settingsKey(ckRaw, vaultId, kv), p.ct, `${SETTINGS_MARKER}|${SEALED_VERSION}|${p.head}`);
  if (!plain) refuse('tampered', 'settings copy changed or under another key');
  let body;
  try {
    body = JSON.parse(plain.toString('utf8'));
  } catch {
    refuse('format', 'settings copy without settings');
  }
  const given = body?.settings;
  if (!given || typeof given !== 'object' || Array.isArray(given) || Object.keys(body).length !== 1) refuse('format', 'settings copy without settings');
  const settings = pickSettings(given);
  const dropped = Object.keys(given).filter((k) => !Object.hasOwn(settings, k));
  if (Array.isArray(given.containers) && settings.containers && settings.containers.length !== given.containers.length) dropped.push('containers');
  return { settings, device: p.device, exportedAt: p.exportedAt, dropped: [...new Set(dropped)] };
}
