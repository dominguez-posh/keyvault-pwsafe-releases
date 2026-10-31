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

/**
 * How well an entry's URLs fit the page – for ordering, never for filtering (host matching decides that):
 * 0 no URL for this host, 1 same site, 2 exact host, plus 1 per matching path segment ("keevault.de/admin" on
 * https://keevault.de/admin/users scores 3). Higher = shown first.
 */
export function urlScore(urls, pageUrl) {
  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    return 0;
  }
  const pageHost = normalizeHost(page.hostname);
  const pageSegs = page.pathname.split('/').filter(Boolean).map((x) => x.toLowerCase());
  let best = 0;
  for (const raw of urls || []) {
    let u;
    try {
      u = new URL(normalizeUrl(raw));
    } catch {
      continue;
    }
    const host = normalizeHost(u.hostname);
    if (!hostMatches(pageHost, host)) continue;
    let score = host === pageHost ? 2 : 1;
    const segs = u.pathname.split('/').filter(Boolean).map((x) => x.toLowerCase());
    if (segs.length) {
      // The entry's path must be a prefix of the page path; a different path ranks below a bare host.
      if (segs.every((s, i) => pageSegs[i] === s)) score += segs.length;
      else score -= 1;
    }
    best = Math.max(best, score);
  }
  return best;
}

// Normalizes a URL typed by the user ("github.com/login" → "https://github.com/login").
export function normalizeUrl(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}
