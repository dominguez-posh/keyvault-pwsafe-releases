// API: vault settings (#480) – appearance, contact person, rules and templates, protection defaults of a Key Vault vault,
// stored in its metadata secret (extension/core/vault-settings.js). Changing them is for a Verwalter only, checked in the
// session (writeVaultSettings), not only in the window.

import { shell } from 'electron';
import { t } from '../../../extension/core/i18n.js';
import {
  TEMPLATES_MAX, canEditSettings, mailtoOf, readVaultSettings, storedVaultSettings, templateFromItem, writeVaultSettings,
} from '../../../extension/core/vault-settings.js';
import { smokeTest } from '../boot.js';
import { vault } from '../state.js';
import { requireOpen } from '../guards.js';
import { changed } from '../session.js';

export const vaultSettingsApi = {
  /** → { settings (cleaned, fresh from the vault), canEdit } */
  async vaultSettings(containerId) {
    requireOpen();
    const c = await vault.container(containerId);
    return { settings: await readVaultSettings(vault, containerId, { fresh: true }), canEdit: canEditSettings(c) };
  },
  /** patch: { look?, contact?, rules?, protect? } – each group given is replaced by its cleaned value. */
  async setVaultSettings(containerId, patch) {
    requireOpen();
    const settings = await writeVaultSettings(vault, containerId, patch);
    changed();
    return settings;
  },
  /** Group 3: an entry's preset values as a template of the vault; the entry is read here, its secrets never go in. */
  async addVaultTemplate(containerId, itemId, name) {
    requireOpen();
    const tpl = templateFromItem(await vault.getItem(containerId, itemId, { fresh: true }), name);
    if (!tpl) throw new Error(t('Bitte einen Namen eingeben'));
    const { rules } = await readVaultSettings(vault, containerId, { fresh: true });
    if (rules.templates.length >= TEMPLATES_MAX) throw new Error(t('Höchstens {n} Vorlagen je Tresor', { n: TEMPLATES_MAX }));
    const settings = await writeVaultSettings(vault, containerId, { rules: { ...rules, templates: [...rules.templates, { ...tpl, id: `t${Date.now().toString(36)}` }] } });
    changed();
    return settings;
  },
  /**
   * Group 2: mail to the vault's contact person – the address comes from the stored settings (also when the vault can't
   * be read right now: "Kein Zugriff"), never from the window; only mailto:.
   */
  async openContactMail(containerId) {
    requireOpen();
    const url = mailtoOf((await storedVaultSettings(vault))[containerId]?.contact?.email);
    if (!url) return false;
    if (smokeTest) globalThis.kvSmokeMailto = url;
    else await shell.openExternal(url);
    return true;
  },
};
