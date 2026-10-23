// Website matching for autofill. Deliberately strict: an entry for example.com matches example.com
// and its subdomains, never sibling domains (no guessing of registrable domains).

export function normalizeHost(host) {
  let h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

export function hostFromUrl(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
    return normalizeHost(url.hostname);
  } catch {
    return null;
  }
}

export function hostMatches(pageHost, itemHost) {
  const page = normalizeHost(pageHost);
  const item = normalizeHost(itemHost);
  if (!page || !item) return false;
  if (page === item) return true;
  return item.includes('.') && page.endsWith(`.${item}`);
}

export function itemMatchesHost(hosts, pageHost) {
  return (hosts || []).some((h) => hostMatches(pageHost, h));
}

// Normalizes a URL typed by the user ("github.com/login" → "https://github.com/login").
export function normalizeUrl(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}
