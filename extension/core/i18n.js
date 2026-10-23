// Languages. German is the source language: t('Deutscher Text', { param }) looks the text up in the
// English dictionary (i18n-en.js) when English is active and falls back to the German original.

import EN from './i18n-en.js';

export const LANGUAGES = { auto: 'Automatisch', de: 'Deutsch', en: 'English' };
const DICTIONARIES = { en: EN };
let current = 'de';

/** 'auto' follows the browser/OS language (German for de-*, otherwise English). */
export function resolveLanguage(setting, systemLocale = globalThis.navigator?.language || '') {
  if (setting === 'de' || setting === 'en') return setting;
  return String(systemLocale).toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function setLanguage(setting, systemLocale) {
  current = resolveLanguage(setting, systemLocale);
  if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = current;
  return current;
}

export const getLanguage = () => current;
export const locale = () => (current === 'en' ? 'en-GB' : 'de-DE');

export function t(key, params) {
  let text = (current !== 'de' && DICTIONARIES[current]?.[key]) || key;
  if (params) text = text.replace(/\{(\w+)\}/g, (m, name) => (params[name] != null ? String(params[name]) : m));
  return text;
}
