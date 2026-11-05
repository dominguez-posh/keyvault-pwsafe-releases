// Explanation window (desktop/main/hint-window.js, #338): why Keevault cannot sign in by itself and what to do instead.
// The main process passes the finished, translated texts in the address (#…, JSON) – no values, no secrets.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let content = {};
try { content = JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch { /* empty window */ }
document.documentElement.lang = content.lang || 'de';
document.title = content.title || 'Keevault';

const root = document.getElementById('hint');
const head = el('div', 'hint-head');
head.append(el('span', 'hint-logo', 'K'), el('h1', '', content.title || ''));
root.append(head);
if (content.why) {
  root.append(el('h2', '', content.whyTitle || ''), el('p', 'hint-why', content.why));
}
if (Array.isArray(content.steps) && content.steps.length) {
  root.append(el('h2', '', content.stepsTitle || ''));
  const list = el('ol', 'hint-steps');
  for (const s of content.steps) list.append(el('li', '', s));
  root.append(list);
}
if (content.note) root.append(el('p', 'hint-note', content.note));
const close = el('button', 'btn primary', content.close || 'OK');
close.type = 'button';
close.addEventListener('click', () => window.close());
const row = el('div', 'hint-actions');
row.append(close);
root.append(row);
