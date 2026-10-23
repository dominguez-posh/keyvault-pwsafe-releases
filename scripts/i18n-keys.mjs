// Lists all translation keys: literal t('…') calls plus label tables that are translated with t(variable).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

const STR = "'((?:[^'\\\\]|\\\\.)*)'";

export function collectKeys() {
  const files = ['extension', 'desktop'].flatMap((d) => walk(join(root, d))).filter((f) => f.endsWith('.js') && !f.endsWith('i18n-en.js'));
  const keys = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(new RegExp(`\\bt\\(\\s*${STR}`, 'g'))) keys.add(m[1]);
    // Label tables translated at runtime with t(variable).
    for (const block of src.matchAll(/(?:LABELS?|ITEM_TYPES|FORMATS|LANGUAGES|ACCESS_LEVELS)\s*=\s*([[{][\s\S]*?[\]}]);/g)) {
      for (const m of block[1].matchAll(new RegExp(`(?::\\s*|^\\s*)${STR}`, 'gm'))) keys.add(m[1]);
    }
    for (const m of src.matchAll(new RegExp(`\\[\\s*'[a-z_]+'\\s*,\\s*${STR}\\s*\\]`, 'g'))) keys.add(m[1]);
    for (const m of src.matchAll(new RegExp(`\\[\\s*${STR}\\s*,\\s*(?:true|false)\\s*\\]`, 'g'))) keys.add(m[1]);
  }
  return [...keys].filter((k) => /[a-zäöüß]/i.test(k)).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const keys = collectKeys();
  console.log(keys.join('\n'));
  console.error(`${keys.length} keys`);
}
