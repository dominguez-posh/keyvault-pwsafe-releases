// Help dialog and the links for bug reports and feature requests.

import { h, icon, modal } from '../../../extension/core/dom.js';
import { t, getLanguage } from '../../../extension/core/i18n.js';
import { st } from './state.js';
import { openUrl } from './helpers.js';

/** Help: the most useful tips for daily use and links into the knowledge base on the website (in the app's language). */
export function helpDialog() {
  const en = getLanguage() === 'en';
  const kb = (de, enSlug) => (en ? `https://keevault.de/en/knowledge/${enSlug}.html` : `https://keevault.de/wissen/${de}.html`);
  const tip = (keys, text) => h('li', {}, keys ? h('kbd', {}, keys) : null, h('span', {}, text));
  const article = (iconName, title, sub, url) => h('button', { type: 'button', class: 'help-article', onclick: () => openUrl(url) },
    h('span', { class: 'help-article-icon' }, icon(iconName, 16)), h('span', { class: 'help-article-text' }, h('b', {}, title), h('span', {}, sub)), icon('external', 14));
  modal(t('Hilfe'), h('div', { class: 'help' },
    h('h3', {}, t('Tipps für jeden Tag')),
    h('ul', { class: 'help-tips' },
      tip(t('Strg F'), t('Suchen – standardmäßig im geöffneten Tresor, mit „Alle“ in allen Tresoren.')),
      tip(t('Strg N'), t('Neuer Eintrag: Login, Notiz, Karte oder Zertifikat.')),
      tip(t('Rechtsklick'), t('Auf Einträgen und Tresoren: alle Funktionen, z. B. „Link kopieren“ für Kolleginnen und Kollegen.')),
      tip(t('Strg+Umschalt+U / P / O'), t('Benutzername, Passwort oder Einmalcode in jedes Fenster tippen (Auto-Type, einstellbar).')),
      tip(null, t('Passkeys: Die Browser-Erweiterung und Windows fragen Keevault – der Anhänger oben im Browser zeigt, welches Konto genutzt wird.')),
      tip(null, t('Schloss oben links sperrt Keevault sofort; das Menü daneben enthält Einstellungen und Werkzeuge.'))),
    h('h3', {}, t('Wissensdatenbank')),
    h('div', { class: 'help-articles' },
      article('check', t('Erste Schritte'), t('Installieren, anmelden, ersten Tresor öffnen'), kb('erste-schritte', 'getting-started')),
      article('key', t('Passkeys'), t('Im Browser und unter Windows nutzen'), kb('passkeys', 'passkeys')),
      article('users', t('Teilen und Zugriff'), t('Kolleginnen und Kollegen einladen, Rollen'), kb('teilen', 'sharing')),
      article('info', t('Fehlerbehebung'), t('Wenn etwas nicht klappt'), kb('fehlerbehebung', 'troubleshooting')),
      article('shield', t('Sicherheit'), t('Wie Keevault schützt – und wo die Grenzen liegen'), en ? 'https://keevault.de/en/security.html' : 'https://keevault.de/sicherheit.html'),
      article('note', t('FAQ'), t('Antworten auf häufige Fragen'), en ? 'https://keevault.de/en/faq.html' : 'https://keevault.de/faq.html')),
    // Bug report and feature request (#311): the form on keevault.de with version and system filled in.
    h('div', { class: 'help-feedback' },
      h('button', { type: 'button', class: 'btn small', dataset: { feedback: 'bug' }, onclick: () => openUrl(feedbackUrl('bug', en)) }, icon('flag', 14), t('Bug melden')),
      h('button', { type: 'button', class: 'btn small', dataset: { feedback: 'feature' }, onclick: () => openUrl(feedbackUrl('feature', en)) }, icon('star', 14), t('Feature-Wunsch'))),
    h('div', { class: 'help-foot' },
      h('button', { type: 'button', class: 'linklike', onclick: () => openUrl(en ? 'https://keevault.de/en/knowledge/index.html' : 'https://keevault.de/wissen/index.html') }, t('Alle Artikel')),
      h('button', { type: 'button', class: 'linklike', onclick: () => openUrl(en ? 'https://keevault.de/en/support.html' : 'https://keevault.de/support.html') }, t('Support')),
      h('span', { class: 'muted' }, `Keevault ${st.version}`))), [{ label: t('Schließen'), primary: true }]);
}

/** Address of the feedback form on keevault.de with type, app version and system (nothing else leaves the app). */
function feedbackUrl(type, en) {
  const os = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[st.platform] || st.platform || '';
  return `https://keevault.de/${en ? 'en/' : ''}feedback.html?${new URLSearchParams({ type, version: st.version || '', os })}`;
}
