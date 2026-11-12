// Checks in front of an action: app open, feature allowed in the vault, PIN, owner of the subscription.

import { LockedError } from '../auth.js';
import { PinGuard } from '../pin.js';
import { PasskeyPinGate } from '../passkey-pin.js';
import { ExportPinGate } from '../export-pin.js';
import { CopyPinGate } from '../copy-pin.js';
import { POLICY_LABELS } from '../../extension/core/session.js';
import { keepAdminFlags, keepServer } from '../../extension/core/model.js';
import { t } from '../../extension/core/i18n.js';
import { config, opened, vault } from './state.js';

export function requireOpen() {
  if (!opened) throw new LockedError();
}

/** Backup and restore: Key Vault container whose subscription the user owns. → container */
export async function requireSubscriptionOwner(containerId) {
  const c = await vault.container(containerId);
  if (c.kind !== 'keyvault') throw new Error(t('Backups gibt es nur für Tresore in Azure Key Vault'));
  const azure = vault.azureFor(c);
  const resourceId = c.resourceId || (await azure.findVault(c.vaultUrl).catch(() => null))?.resourceId;
  const subscriptionId = /\/subscriptions\/([^/]+)/i.exec(resourceId || '')?.[1];
  if (!subscriptionId) throw new Error(t('Die Subscription dieses Tresors ist nicht bekannt.'));
  if (!(await azure.subscriptionOwner(subscriptionId).catch(() => false))) {
    throw new Error(t('Backup und Wiederherstellung sind nur für Besitzer (Owner) der Subscription möglich.'));
  }
  return c;
}

export const pinGuard = new PinGuard(); // counter restored from the settings once config exists (app ready)

/** #439: every passkey use asks for the app PIN (see ../passkey-pin.js); shares the counter of unlocking. */
export const passkeyPin = new PasskeyPinGate({
  settings: () => config.get(),
  guard: pinGuard,
  save: (state) => { if (state || config.get().pinGuard) config.update({ pinGuard: state }); },
});

/** #473: a plaintext export asks for the app PIN (see ../export-pin.js); the same counter as unlocking. */
export const exportPin = new ExportPinGate({ settings: () => config.get(), guard: pinGuard, save: passkeyPin.save });

/** #480: copying from a vault whose settings want the app PIN (see ../copy-pin.js); the same counter as unlocking. */
export const copyPin = new CopyPinGate({ settings: () => config.get(), guard: pinGuard, save: passkeyPin.save });

/** Unlocking needs a freshly verified PIN once one is set. */
export function requirePin() {
  if (config.get().appPin && !pinGuard.consume()) {
    const e = new Error(t('Bitte zuerst die PIN eingeben'));
    e.name = 'PinRequired';
    throw e;
  }
}

/**
 * Vault settings: Key Vault administrators may do everything; everyone else only what an admin enabled
 * (Key Vault vaults only – file vaults have their own roles). → container
 */
export async function requireFeature(containerId, feature) {
  const c = await vault.container(containerId);
  if (c.kind !== 'keyvault' || c.access?.admin) return c;
  const p = await vault.policy(containerId);
  if (!p?.features[feature]) {
    throw new Error(t('Diese Funktion hat ein Admin des Tresors nicht freigeschaltet: {feature}', { feature: t(POLICY_LABELS[feature]) }));
  }
  return c;
}

/**
 * #487: admin flags (msAdmin, sophos) and server entries change only in admin mode; otherwise – and always from the browser, whose popup has
 * no admin options – a save keeps the stored values. → the item to save
 */
export async function adminFlagsGuard(containerId, item, { browser = false } = {}) {
  if (!item || (!browser && config.get().adminTools === true)) return item;
  // Only the vault the save goes to; a read error stops the save instead of clearing the stored flags (review #487).
  const stored = item.id ? await vault.getItem(containerId, item.id, { fresh: true }) : null;
  // Lucas, 2026-11-10: server entries likewise – outside admin mode their server data stays as stored, none is created.
  return keepAdminFlags(keepServer(item, stored), stored);
}
