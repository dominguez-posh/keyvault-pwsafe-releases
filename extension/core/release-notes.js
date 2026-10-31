// Release notes as the app shows them: the "releaseNotes" block of the signed update manifest holds the newest
// CHANGELOG.md sections ("## <version> – <date>", German list, English list under "### English"), newest first.
// No Node imports – used by the renderer and the unit tests.

/** The part of the release notes for one language; version headings are left out (apps up to 0.7.15 use this). */
export function notesForLanguage(notes, language) {
  const [de, en = ''] = String(notes || '').split(/^###\s+English\s*$/mi);
  const part = language === 'en' && en.trim() ? en : de;
  return part.split('\n').filter((l) => !/^##\s/.test(l)).join('\n').trim();
}

/** "1.2.10" vs "1.2.9" → 1 (numeric per part). */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}

/**
 * Versions newer than `installed` with their changes in `language` (German if a section has no English list):
 * [{ version, date, items: ['…'] }], newest first. A notes block without headings counts as one unnamed version.
 */
export function releaseNotesSince(notes, installed, language) {
  const text = String(notes || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  const parts = /^## /m.test(text) ? text.split(/^(?=## )/m) : [text];
  const out = [];
  for (const part of parts) {
    const head = /^## (\S+)(?:\s+[–-]\s+(.+))?$/m.exec(part);
    const version = head?.[1] || '';
    if (version && installed && compareVersions(version, installed) <= 0) continue;
    const [de, en = ''] = part.split(/^###\s+English\s*$/mi);
    const body = (language === 'en' && en.trim() ? en : de).split('\n').filter((l) => !/^##\s/.test(l));
    // "- " starts an item, indented or plain lines continue it.
    const items = [];
    for (const line of body) {
      if (/^\s*[-*] /.test(line)) items.push(line.replace(/^\s*[-*] /, '').trim());
      else if (line.trim() && items.length) items[items.length - 1] += ` ${line.trim()}`;
      else if (line.trim()) items.push(line.trim());
    }
    if (items.length) out.push({ version, date: head?.[2]?.trim() || '', items });
  }
  return out;
}
