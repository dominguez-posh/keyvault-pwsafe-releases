// Draws the illustrations of the Azure portal guide: simplified versions of the portal screens with numbered
// markers, in German (docs/images/azure/*.svg) and English (docs/images/azure/en/*.svg). Simplified on purpose –
// real screenshots change with every portal update.
//   node scripts/azure-illustrations.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = fileURLToPath(new URL('../docs/images/azure/', import.meta.url));

const W = 880;
const C = { blue: '#0078d4', dark: '#1b1b1f', line: '#d5d9e0', text: '#1b1b1f', muted: '#605e5c', soft: '#f3f6fb', mark: '#e8590c', ok: '#107c10', bad: '#c50f1f' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, s, { size = 13, weight = 400, fill = C.text, anchor = 'start', mono = false } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${mono ? ' font-family="Consolas, monospace"' : ''}>${esc(s)}</text>`;
const rect = (x, y, w, h, { fill = '#fff', stroke = C.line, r = 4, sw = 1 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const mark = (n, x, y) => `<circle cx="${x}" cy="${y}" r="12" fill="${C.mark}"/>${text(x, y + 4.5, n, { size: 13, weight: 700, fill: '#fff', anchor: 'middle' })}`;
const highlight = (x, y, w, h) => rect(x - 4, y - 4, w + 8, h + 8, { fill: 'none', stroke: C.mark, r: 6, sw: 2.5 });
const button = (x, y, label, { primary = false, w } = {}) => {
  const width = w || label.length * 7.4 + 28;
  return rect(x, y, width, 30, { fill: primary ? C.blue : '#fff', stroke: primary ? C.blue : C.line }) + text(x + width / 2, y + 20, label, { size: 13, weight: 600, fill: primary ? '#fff' : C.text, anchor: 'middle' });
};
const field = (x, y, label, value, { w = 380, select = true } = {}) =>
  text(x, y, label, { size: 12.5, weight: 600 }) + rect(x, y + 8, w, 30) + text(x + 10, y + 28, value, { size: 13 }) +
  (select ? `<path d="M${x + w - 20} ${y + 20} l5 5 l5 -5" fill="none" stroke="${C.muted}" stroke-width="1.5"/>` : '');
const radio = (x, y, label, on, note = '') => `<circle cx="${x + 8}" cy="${y - 4}" r="7" fill="#fff" stroke="${on ? C.blue : C.muted}" stroke-width="1.5"/>` +
  (on ? `<circle cx="${x + 8}" cy="${y - 4}" r="3.5" fill="${C.blue}"/>` : '') + text(x + 24, y, label, { size: 13, weight: on ? 600 : 400 }) + (note ? text(x + 24, y + 18, note, { size: 12, fill: C.muted }) : '');
const tabs = (x, y, list, active) => {
  let cx = x;
  return list.map((t) => {
    const w = t.length * 7.2 + 24;
    const s = text(cx + w / 2, y, t, { size: 13, weight: t === active ? 700 : 400, fill: t === active ? C.blue : C.muted, anchor: 'middle' }) +
      (t === active ? `<rect x="${cx + 6}" y="${y + 8}" width="${w - 12}" height="3" fill="${C.blue}"/>` : '');
    cx += w;
    return s;
  }).join('') + `<line x1="${x}" y1="${y + 11}" x2="${W - 30}" y2="${y + 11}" stroke="${C.line}"/>`;
};

function draw(lang) {
  const L = (de, en) => (lang === 'en' ? en : de);
  const frame = (h, title, body, crumb) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" font-family="Segoe UI, system-ui, sans-serif" role="img" aria-label="${esc(title)}">
<rect width="${W}" height="${h}" rx="10" fill="#fff" stroke="${C.line}"/>
<path d="M0 10 a10 10 0 0 1 10 -10 h${W - 20} a10 10 0 0 1 10 10 v30 h-${W} z" fill="${C.dark}"/>
${text(18, 25, 'Microsoft Azure', { size: 13, weight: 600, fill: '#fff' })}
<rect x="300" y="9" width="300" height="22" rx="4" fill="#3b3a39"/>${text(312, 25, L('Ressourcen, Dienste und Dokumente durchsuchen', 'Search resources, services, and docs'), { size: 11.5, fill: '#c8c6c4' })}
${text(24, 64, crumb, { size: 12, fill: C.blue })}
${text(24, 92, title, { size: 20, weight: 600 })}
${body}
${text(W - 18, h - 12, L('Vereinfachte Darstellung – Beschriftungen können je nach Portal-Version leicht abweichen', 'Simplified view – labels may differ slightly depending on the portal version'), { size: 10.5, fill: C.muted, anchor: 'end' })}
</svg>
`;

  const home = L('Startseite', 'Home');
  const vaults = L('Schlüsseltresore', 'Key vaults');
  const create = L('+ Erstellen', '+ Create');
  const createTabs = L(['Grundlagen', 'Zugriffskonfiguration', 'Netzwerk', 'Tags', 'Überprüfen + erstellen'], ['Basics', 'Access configuration', 'Networking', 'Tags', 'Review + create']);
  const createTitle = L('Schlüsseltresor erstellen', 'Create a key vault');
  const next = L('Weiter', 'Next');
  const roleTabs = L(['Rolle', 'Mitglieder', 'Überprüfen und zuweisen'], ['Role', 'Members', 'Review + assign']);
  const iam = L('Zugriffssteuerung (IAM)', 'Access control (IAM)');
  const name = (de, en) => L(de, en);

  return {
    [L('01-schluesseltresore.svg', '01-key-vaults.svg')]: frame(330, vaults, [
      rect(300, 9, 300, 22, { fill: '#3b3a39', stroke: C.mark, sw: 2 }),
      text(312, 25, vaults, { size: 12, fill: '#fff' }),
      mark('1', 620, 20),
      button(24, 118, create, { primary: true }),
      highlight(24, 118, 102, 30), mark('2', 146, 133),
      button(168, 118, L('Ansicht verwalten', 'Manage view')), button(332, 118, L('Aktualisieren', 'Refresh')),
      rect(24, 170, W - 48, 34, { fill: C.soft }),
      text(40, 192, name('Name', 'Name'), { weight: 600 }), text(330, 192, L('Typ', 'Type'), { weight: 600 }), text(520, 192, L('Ressourcengruppe', 'Resource group'), { weight: 600 }), text(720, 192, L('Standort', 'Location'), { weight: 600 }),
      text(40, 230, L('Noch keine Schlüsseltresore vorhanden', 'No key vaults to display'), { fill: C.muted }),
      text(24, 280, L('① Oben in der Suche „Schlüsseltresore“ (englisch: „Key Vaults“) eingeben und öffnen.', '① Type “Key vaults” into the search at the top and open it.'), { size: 13 }),
      text(24, 302, L('② „+ Erstellen“ wählen.', '② Choose “+ Create”.'), { size: 13 }),
    ].join(''), home),

    [L('02-grundlagen.svg', '02-basics.svg')]: frame(560, createTitle, [
      tabs(24, 126, createTabs, createTabs[0]),
      text(24, 166, L('Projektdetails', 'Project details'), { size: 14, weight: 700 }),
      field(24, 190, L('Abonnement *', 'Subscription *'), L('Firmen-Abonnement', 'Company subscription')),
      field(24, 250, L('Ressourcengruppe *', 'Resource group *'), 'rg-keevault'), mark('1', 420, 278),
      text(470, 166, L('Instanzdetails', 'Instance details'), { size: 14, weight: 700 }),
      field(470, 190, L('Schlüsseltresorname *', 'Key vault name *'), 'kv-pws-teamops', { select: false, w: 380 }), highlight(470, 198, 380, 30), mark('2', 860, 213),
      field(470, 250, L('Region *', 'Region *'), 'Germany West Central', { w: 380 }), mark('3', 860, 273),
      field(470, 310, L('Tarif *', 'Pricing tier *'), 'Standard', { w: 380 }),
      text(24, 340, L('Wiederherstellungsoptionen', 'Recovery options'), { size: 14, weight: 700 }),
      field(24, 364, L('Tage zum Beibehalten gelöschter Tresore', 'Days to retain deleted vaults'), '90', { select: false, w: 120 }),
      text(24, 436, L('Bereinigungsschutz', 'Purge protection'), { size: 12.5, weight: 600 }),
      radio(24, 462, L('Bereinigungsschutz aktivieren (empfohlen, nicht umkehrbar)', 'Enable purge protection (recommended, cannot be undone)'), true), highlight(24, 448, 410, 22), mark('4', 452, 459),
      radio(24, 490, L('Bereinigungsschutz deaktivieren', 'Disable purge protection'), false),
      button(W - 150, 500, next, { primary: true, w: 120 }),
    ].join(''), `${home} › ${vaults}`),

    [L('03-zugriffskonfiguration.svg', '03-access-configuration.svg')]: frame(380, createTitle, [
      tabs(24, 126, createTabs, createTabs[1]),
      text(24, 170, L('Berechtigungsmodell', 'Permission model'), { size: 14, weight: 700 }),
      radio(24, 204, L('Rollenbasierte Zugriffssteuerung in Azure (empfohlen)', 'Azure role-based access control (recommended)'), true, L('Zugriff über Azure-Rollen – das nutzt Keevault.', 'Access through Azure roles – this is what Keevault uses.')),
      highlight(24, 188, 430, 40), mark('1', 474, 205),
      radio(24, 262, L('Tresorzugriffsrichtlinie', 'Vault access policy'), false, L('Älteres Modell – damit funktioniert Keevault nicht.', 'Older model – Keevault does not work with it.')),
      `<line x1="48" y1="258" x2="210" y2="258" stroke="${C.bad}" stroke-width="2"/>`,
      text(24, 318, L('Die übrigen Optionen auf dieser Seite (VMs, ARM-Vorlagen, Disk Encryption) bleiben aus.', 'Leave the other options on this page (VMs, ARM templates, disk encryption) turned off.'), { size: 13, fill: C.muted }),
      button(W - 150, 330, next, { primary: true, w: 120 }),
    ].join(''), `${home} › ${vaults}`),

    '04-tags.svg': frame(360, createTitle, [
      tabs(24, 126, createTabs, 'Tags'),
      text(24, 166, L('Mit Tags findet Keevault den Tresor automatisch und zeigt den Anzeigenamen.', 'With tags, Keevault finds the vault automatically and shows the display name.'), { size: 13, fill: C.muted }),
      rect(24, 184, W - 48, 32, { fill: C.soft }),
      text(40, 205, 'Name', { weight: 600 }), text(330, 205, L('Wert', 'Value'), { weight: 600 }), text(640, 205, L('Ressource', 'Resource'), { weight: 600 }),
      rect(24, 224, 280, 30), text(36, 244, 'kvpwsafe', { mono: true }), rect(318, 224, 300, 30), text(330, 244, 'container', { mono: true }), text(640, 244, L('Schlüsseltresor', 'Key vault')),
      rect(24, 264, 280, 30), text(36, 284, 'kvpwsafe-name', { mono: true }), rect(318, 264, 300, 30), text(330, 284, 'Team Ops'), text(640, 284, L('Schlüsseltresor', 'Key vault')),
      highlight(24, 224, 594, 70), mark('1', 640, 222),
      text(24, 326, L('„kvpwsafe-name“ ist der Name, den alle in Keevault sehen. Danach: „Überprüfen + erstellen“ → „Erstellen“.', '“kvpwsafe-name” is the name everyone sees in Keevault. Then: “Review + create” → “Create”.'), { size: 13 }),
    ].join(''), `${home} › ${vaults}`),

    [L('05-rollenzuweisung.svg', '05-role-assignment.svg')]: frame(470, `kv-pws-teamops | ${iam}`, [
      rect(24, 112, 200, 310, { fill: C.soft, stroke: C.soft }),
      ...L(['Übersicht', 'Aktivitätsprotokoll', iam, 'Tags', 'Objekte', 'Einstellungen'], ['Overview', 'Activity log', iam, 'Tags', 'Objects', 'Settings']).map((t, i) =>
        text(40, 140 + i * 30, t, { size: 13, weight: i === 2 ? 700 : 400, fill: i === 2 ? C.blue : C.text })),
      highlight(30, 188, 188, 26), mark('1', 230, 201),
      button(250, 112, L('+ Hinzufügen', '+ Add'), { primary: true }), mark('2', L(370, 330), 127),
      rect(250, 148, 230, 30, { fill: '#fff' }), text(262, 168, L('Rollenzuweisung hinzufügen', 'Add role assignment'), { size: 13, weight: 600 }), highlight(250, 148, 230, 30),
      tabs(250, 214, roleTabs, roleTabs[0]),
      rect(250, 240, 300, 30), text(262, 260, 'Key Vault Secrets', { size: 13 }), mark('3', 568, 255),
      rect(250, 282, W - 280, 30, { fill: C.soft }), text(264, 302, 'Name', { weight: 600 }), text(560, 302, L('Beschreibung', 'Description'), { weight: 600 }),
      rect(250, 318, W - 280, 30, { fill: '#e8f1fb', stroke: C.blue }), text(264, 338, 'Key Vault Secrets Officer', { weight: 600 }), text(560, 338, L('Einträge lesen und bearbeiten', 'Read and edit entries'), { size: 12.5 }),
      rect(250, 352, W - 280, 30), text(264, 372, 'Key Vault Secrets User'), text(560, 372, L('Einträge nur lesen', 'Read entries only'), { size: 12.5 }),
      text(250, 412, L('Bearbeiten = „Secrets Officer“, Lesen = „Secrets User“. Zusätzlich je einmal „Leser“ vergeben.', 'Edit = “Secrets Officer”, Read = “Secrets User”. Additionally assign “Reader” once each.'), { size: 12.5, fill: C.muted }),
    ].join(''), `${home} › ${vaults} › kv-pws-teamops`),

    [L('06-mitglieder.svg', '06-members.svg')]: frame(450, L('Rollenzuweisung hinzufügen', 'Add role assignment'), [
      tabs(24, 126, roleTabs, roleTabs[1]),
      text(24, 168, L('Ausgewählte Rolle', 'Selected role'), { size: 12.5, weight: 600 }), text(220, 168, 'Key Vault Secrets Officer'),
      text(24, 204, L('Zugriff zuweisen zu', 'Assign access to'), { size: 12.5, weight: 600 }),
      radio(220, 208, L('Benutzer, Gruppe oder Dienstprinzipal', 'User, group, or service principal'), true), radio(520, 208, L('Verwaltete Identität', 'Managed identity'), false),
      text(24, 246, L('Mitglieder', 'Members'), { size: 12.5, weight: 600 }), button(220, 228, L('+ Mitglieder auswählen', '+ Select members')), mark('1', L(410, 380), 243),
      rect(220, 272, 560, 30, { fill: C.soft }), text(234, 292, 'Name', { weight: 600 }), text(520, 292, L('Typ', 'Type'), { weight: 600 }),
      rect(220, 306, 560, 30), text(234, 326, L('PW Team Ops – Bearbeiten', 'PW Team Ops – Edit')), text(520, 326, L('Gruppe', 'Group')),
      rect(220, 340, 560, 30), text(234, 360, L('Dienstleister (Gast)', 'Contractor (guest)')), text(520, 360, L('Benutzer', 'User')),
      highlight(220, 306, 560, 64), mark('2', 800, 322),
      button(W - 220, 382, L('Überprüfen und zuweisen', 'Review + assign'), { primary: true, w: 190 }), mark('3', W - 238, 397),
    ].join(''), `${home} › ${vaults} › kv-pws-teamops › ${iam}`),
  };
}

// Deploy-to-Azure button (local copy, so the website loads nothing from third parties).
const deployButton = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 196 36" width="196" height="36" font-family="Segoe UI, system-ui, sans-serif" role="img" aria-label="Deploy to Azure">
<rect width="196" height="36" rx="4" fill="${C.blue}"/>
<path d="M14 25 L21 9 h5 l-7 16 z M20 25 l8 -10 l6 10 z" fill="#fff"/>
${text(44, 23, 'Deploy to Azure', { size: 15, weight: 600, fill: '#fff' })}
</svg>
`;

let count = 0;
for (const [lang, dir] of [['de', base], ['en', join(base, 'en')]]) {
  mkdirSync(dir, { recursive: true });
  for (const [name, svg] of Object.entries(draw(lang))) {
    writeFileSync(join(dir, name), svg);
    count++;
  }
}
writeFileSync(join(base, 'deploy-to-azure.svg'), deployButton);
console.log(`${count + 1} Abbildungen in ${base}`);
