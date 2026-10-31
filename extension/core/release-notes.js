// Release notes as the app shows them: the "releaseNotes" block of the signed update manifest is the CHANGELOG.md
// section of the new version (German first, English list under "### English"). No Node imports – used by the
// renderer and the unit tests.

/** The part of the release notes for one language; the version heading itself is left out. */
export function notesForLanguage(notes, language) {
  const [de, en = ''] = String(notes || '').split(/^###\s+English\s*$/mi);
  const part = language === 'en' && en.trim() ? en : de;
  return part.split('\n').filter((l) => !/^##\s/.test(l)).join('\n').trim();
}
