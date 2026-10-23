// Minimal XML parser (elements, attributes, text, CDATA, entities) – enough for KeePass XML exports, and it
// runs everywhere (no DOMParser in Node).

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

/** Parses XML into { name, attrs, children: [nodes], text } (text = concatenated direct text content). */
export function parseXml(xml) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gy;
  while (re.lastIndex < xml.length) {
    const start = re.lastIndex;
    const m = re.exec(xml);
    if (!m) throw new Error(`XML: Syntaxfehler bei Zeichen ${start}`);
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (top.name !== m[2]) throw new Error(`XML: unerwartetes </${m[2]}>`);
      stack.pop();
    } else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const node = { name: m[3], attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  if (stack.length !== 1) throw new Error('XML: unvollständiges Dokument');
  return root;
}

export const child = (node, name) => node?.children.find((c) => c.name === name) || null;
export const children = (node, name) => (node?.children || []).filter((c) => c.name === name);
export const textOf = (node, name) => (child(node, name)?.text ?? '').trim();
